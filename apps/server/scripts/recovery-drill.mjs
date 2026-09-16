// 六-D：真实进程中断 / 残留态启动恢复演练（可重复）
//
// 说明（范围界定）：
//   本脚本验证的是"原子写/删除残留态(.bak/.tmp) 已形成后，进程重启能否自动恢复"，而非在
//   atomicWriteFile 写文件那几毫秒窗口里精确打断进程。因此命名为"残留态启动恢复演练"，
//   不声称覆盖完整原子写进程中断时序。
//
// 场景 A【停服后残留 + 重启恢复，Note ID 保持】：
//   建笔记 → 停进程（DB 记录保留）→ 造"目标缺失 + .bak 旧正文 + .tmp 残料" →
//   重启同一数据目录 → 断言正文从 .bak 恢复、.tmp/.bak 清理、/api/notes 中该 path 的
//   id 与停服前完全一致。
// 场景 B【运行中强杀 + 残留 + 重启恢复】：
//   建另一篇笔记 → 运行中造残留态（watcher 可能已删其 DB 记录）→ taskkill /F 强杀 →
//   重启 → 断言正文恢复、残料清理、重新建索引（此场景不承诺 id 保持，如实标注）。
//
// 用法（仓库根，先构建服务端再跑）：
//   npm run build -w apps/server
//   npm run recovery:drill -w apps/server
import { spawn, execSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
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
const dbUrl = `file:${join(tmpRoot, 'drill.db').replace(/\\/g, '/')}`
const port = 20000 + Math.floor(Math.random() * 10000)

// 临时库需要先有真实 schema；固定 Prisma CLI 环境，不依赖调用者 shell 是否设了 RUST_LOG
function prepareDb() {
  execSync('node node_modules/prisma/build/index.js db push --skip-generate --schema src/schema.prisma', {
    cwd: serverRoot,
    env: {
      ...process.env,
      DATABASE_URL: dbUrl,
      RUST_LOG: process.env.RUST_LOG || 'info',
      PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING: '1',
    },
    stdio: 'pipe',
  })
}

function baseEnv() {
  return {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    DATA_DIR: notesDir.replace(/[\\/]notes$/, ''),
    NOTES_DIR: notesDir,
    DATABASE_URL: dbUrl,
  }
}

function startServer() {
  return spawn(process.execPath, [distMain], {
    cwd: serverRoot,
    env: baseEnv(),
    stdio: ['ignore', 'ignore', 'inherit'], // stderr 透传，便于诊断启动失败
  })
}

let activeChild = null
function setChild(c) { activeChild = c }
function getChild() { return activeChild }

async function waitReady(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const c = getChild()
    if (c && c.exitCode !== null) throw new Error(`server 提前退出 code=${c.exitCode}`)
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

function stopChild(child) {
  return new Promise((resolveStop) => {
    if (!child || child.exitCode !== null) return resolveStop()
    child.on('close', () => resolveStop())
    child.kill('SIGKILL')
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 800)
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 2000)
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

async function createNote(title, content) {
  const res = await api('POST', '/api/notes', { title, content })
  if (res.status !== 200 && res.status !== 201) throw new Error(`创建 ${title} 失败 ${res.status}`)
  const rel = `${title}.md`
  const abs = join(notesDir, rel)
  if (!existsSync(abs)) throw new Error(`${rel} 未落盘`)
  return { id: res.json.id, rel, abs, content }
}

// 制造残留态：目标缺失(删) + .bak(旧正文) + .tmp(未写完)
async function makeResidual(abs, originalContent, title) {
  await rmSync(abs, { force: true })
  writeFileSync(`${abs}.bak`, originalContent, 'utf8')
  writeFileSync(`${abs}.tmp`, 'incomplete new content', 'utf8')
}

async function assertRestored(note) {
  const now = readFileSync(note.abs, 'utf8')
  if (now !== note.content) throw new Error(`正文未从 .bak 恢复：期望 "${note.content}"，实际 "${now}"`)
  if (existsSync(`${note.abs}.tmp`)) throw new Error('未写完的 .tmp 应被清理，实际仍存在')
  if (existsSync(`${note.abs}.bak`)) throw new Error('恢复成功后 .bak 应被清理，实际仍存在')
}

async function getNoteByPath(rel) {
  const list = await api('GET', '/api/notes')
  return (list.json ?? []).find((n) => n.path === rel) ?? null
}

let ok = true
function report(okFlag, label, detail) {
  if (!okFlag) ok = false
  console.log(`[drill] ${okFlag ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`)
}

void (async () => {
try {
  console.log(`[drill] 残留态启动恢复演练（临时目录: ${tmpRoot}，端口: ${port}）`)
  prepareDb()

  // ===== 场景 A：停服后残留 + 重启，Note ID 保持 =====
  {
    console.log('[drill] === 场景 A：停服后残留 + 重启恢复（断言 Note ID 保持）===')
    const s = startServer(); setChild(s)
    await waitReady()
    const noteA = await createNote('DrillKeep', '场景A原始正文')
    // 先停进程（DB 记录保留、无 watcher 干扰）再制造残留
    const keptId = noteA.id
    await stopChild(s)
    await makeResidual(noteA.abs, noteA.content)
    const b = startServer(); setChild(b)
    await waitReady()
    let pass = true
    try { await assertRestored(noteA) } catch (e) { pass = false; console.error('[drill] 场景A:', e.message) }
    report(pass, '场景A 正文从 .bak 恢复、.tmp/.bak 清理')
    const hitA = await getNoteByPath(noteA.rel)
    report(!!hitA, '场景A /api/notes 重新索引 ' + noteA.rel)
    if (hitA) {
      report(hitA.id === keptId, '场景A Note ID 保持', `停服前=${keptId} 恢复后=${hitA.id}`)
    }
    await stopChild(b)
  }

  // ===== 场景 B：运行中强杀 + 残留 + 重启恢复（不承诺 id 保持）=====
  {
    console.log('[drill] === 场景 B：运行中强杀 + 残留 + 重启恢复（范围如实限定）===')
    const s = startServer(); setChild(s)
    await waitReady()
    const noteB = await createNote('DrillKill', '场景B原始正文')
    // 运行中制造残留（watcher 可能已删其 DB 记录）→ 立即强杀
    await makeResidual(noteB.abs, noteB.content)
    await killHard(s)
    const c = startServer(); setChild(c)
    await waitReady()
    let pass = true
    try { await assertRestored(noteB) } catch (e) { pass = false; console.error('[drill] 场景B:', e.message) }
    report(pass, '场景B 正文从 .bak 恢复、.tmp/.bak 清理')
    const hitB = await getNoteByPath(noteB.rel)
    report(!!hitB, '场景B 重启后重新建立索引 ' + noteB.rel + '（ID 不承诺保持）')
    await stopChild(c)
  }

  console.log(ok ? '[drill] 结果：通过（残留态启动恢复演练，两场景均绿）' : '[drill] 结果：存在失败')
} catch (err) {
  ok = false
  console.error('[drill] 失败:', err.message || err)
} finally {
  await stopChild(getChild())
  rmSync(tmpRoot, { recursive: true, force: true })
}
process.exit(ok ? 0 : 1)
})().catch((e) => { console.error('[drill] 致命错误:', e); process.exit(2) })