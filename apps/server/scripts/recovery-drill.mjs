// 六-D：真实进程中断恢复演练（可重复）
// 场景：API 已建笔记 → 在文件系统模拟"原子写中途进程被杀"的 .bak 残留态 →
//       以 SIGKILL/taskkill 强杀运行中的 server → 重新启动同一数据目录 →
//       验证启动恢复(cleanupTmpFiles)从 .bak 找回正文、索引重建、GET /api/notes 可见。
// 用法（仓库根，先构建服务端再跑）：
//   npm run build -w apps/server
//   node apps/server/scripts/recovery-drill.mjs
import { spawn, execSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const serverRoot = dirname(dirname(fileURLToPath(import.meta.url))) // apps/server
const distMain = join(serverRoot, 'dist', 'index.js')

if (!existsSync(distMain)) {
  console.error('[drill] 未找到 dist/index.js，请先运行：npm run build -w apps/server')
  process.exit(1)
}

const tmpRoot = mkdtempSync(join(tmpdir(), 'tt-drill-'))
const notesDir = join(tmpRoot, 'notes')
const dataDir = join(tmpRoot, 'data')
const dbUrl = `file:${join(tmpRoot, 'drill.db').replace(/\\/g, '/')}`
const port = 20000 + Math.floor(Math.random() * 10000)

// 临时库需要先有真实 schema（prisma db push），否则启动扫描 prisma.findMany 会因无表退出
function prepareDb() {
  execSync('node node_modules/prisma/build/index.js db push --skip-generate --schema src/schema.prisma', {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: 'pipe',
  })
}

function baseEnv() {
  return {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    DATA_DIR: dataDir,
    NOTES_DIR: notesDir,
    DATABASE_URL: dbUrl,
  }
}

function startServer() {
  const child = spawn(process.execPath, [distMain], {
    cwd: serverRoot,
    env: baseEnv(),
    stdio: ['ignore', 'ignore', 'inherit'], // stderr 透传，便于诊断启动失败
  })
  return child
}

async function waitReady(child, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server 提前退出 code=${child.exitCode}`)
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/notes`)
      if (r.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('server 未在超时内就绪')
}

function killHard(child) {
  return new Promise((resolveKill) => {
    if (!child || child.exitCode !== null) return resolveKill()
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/F', '/PID', String(child.pid)], { stdio: 'ignore' })
      killer.on('close', () => resolveKill())
    } else {
      child.kill('SIGKILL')
      child.on('close', () => resolveKill())
    }
  })
}

function stopAndWait(child) {
  return new Promise((resolveStop) => {
    if (!child || child.exitCode !== null) return resolveStop()
    child.on('close', () => resolveStop())
    child.kill('SIGKILL')
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL')
    }, 800)
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL')
    }, 2000)
  })
}

async function api(method, path, body) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: r.status, json, text }
}

let exitCode = 1
let serverA = null
let serverB = null
try {
  console.log(`[drill] 临时目录: ${tmpRoot}`)
  console.log(`[drill] 端口: ${port}`)
  prepareDb()
  console.log('[drill] 临时库 schema 已就绪')

  // 1) 首次启动：建一篇笔记（文件即正文）
  serverA = startServer()
  await waitReady(serverA)
  const before = await api('POST', '/api/notes', { title: 'DrillA', content: '进程中断前的正文' })
  if (before.status !== 200 && before.status !== 201) throw new Error(`创建笔记失败 ${before.status}`)
  const note = before.json
  const aPath = join(notesDir, 'DrillA.md')
  if (!existsSync(aPath)) throw new Error('DrillA.md 未落盘')
  const originalContent = readFileSync(aPath, 'utf8')
  console.log(`[drill] 已建笔记 id=${note.id} path=DrillA.md`)

  // 2) 模拟原子写中途进程被杀：Windows 原子写 = 旧文件先迁 .bak，再把 tmp 替换为目标。
  //    若"备份已就位、tmp 未替换成目标"即进程中断 → 目标缺失 + .bak 有旧正文 + .tmp 残料。
  writeFileSync(`${aPath}.bak`, originalContent, 'utf8')
  try { rmSync(aPath, { force: true }) } catch {}
  // 额外放一个未写完的 .tmp，验证启动时被当作残料丢弃
  writeFileSync(join(notesDir, 'DrillA.md.tmp'), 'incomplete new content', 'utf8')
  console.log(`[drill] 已制造中断态：DrillA.md 缺失、DrillA.md.bak 存在、DrillA.md.tmp 未写完残料`)

  // 3) 强杀运行中的 server，模拟进程中断
  await killHard(serverA)
  serverA = null
  console.log('[drill] 已强杀 serverA')

  // 4) 重新启动同一数据目录：启动恢复应把 .bak 找回为正文、丢弃 .tmp、重建索引
  serverB = startServer()
  await waitReady(serverB)

  // 5) 断言恢复结果
  const restoredFile = readFileSync(aPath, 'utf8')
  if (restoredFile !== originalContent) {
    throw new Error(`正文未从 .bak 恢复：期望 "${originalContent}"，实际 "${restoredFile}"`)
  }
  console.log('[drill] ✓ DrillA.md 已从 .bak 恢复，正文一致')
  if (existsSync(`${aPath}.tmp`)) {
    throw new Error('未写完的 .tmp 应被启动清理，实际仍存在')
  }
  if (existsSync(`${aPath}.bak`)) {
    throw new Error('恢复成功后 .bak 应被清理，实际仍存在')
  }
  console.log('[drill] ✓ 未写完的 .tmp 残料已丢弃、.bak 已清理')

  const listAfter = await api('GET', '/api/notes')
  const items = listAfter.json ?? []
  const hit = items.find((n) => n.path === 'DrillA.md')
  if (!hit) throw new Error('恢复后 /api/notes 未索引 DrillA.md')
  console.log(`[drill] ✓ 恢复后索引重建：DrillA.md -> id=${hit.id} title=${hit.title}`)

  exitCode = 0
  console.log('[drill] 结果：通过')
} catch (err) {
  console.error('[drill] 失败:', err.message || err)
} finally {
  await stopAndWait(serverB)
  await killHard(serverA)
  rmSync(tmpRoot, { recursive: true, force: true })
}
process.exit(exitCode)