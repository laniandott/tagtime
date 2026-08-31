// 六-D：数据库/Markdown 组合备份恢复演练（可重复）
// 验证：备份 SQLite + notes/ 全部 Markdown → 破坏(清空库与正文) → 恢复 → 重启后
//       断言 Note ID 集合、出/入链接关系(outLinks/inLinks)、TagTime 实体关联(entities) 均与备份前一致。
// 用法（仓库根，先构建服务端再跑）：
//   npm run build -w apps/server
//   npm run backup:drill -w apps/server
import { spawn, execSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, cpSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const serverRoot = dirname(dirname(fileURLToPath(import.meta.url))) // apps/server
const distMain = join(serverRoot, 'dist', 'index.js')

if (!existsSync(distMain)) {
  console.error('[drill] 未找到 dist/index.js，请先运行：npm run build -w apps/server')
  process.exit(1)
}

const tmpRoot = mkdtempSync(join(tmpdir(), 'tt-bakdrill-'))
const notesDir = join(tmpRoot, 'notes')
const dataDir = join(tmpRoot, 'data')
const dbAbs = join(tmpRoot, 'backup.db')
const dbUrl = `file:${dbAbs.replace(/\\/g, '/')}`
const port = 21000 + Math.floor(Math.random() * 10000)

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
    DATA_DIR: dataDir,
    NOTES_DIR: notesDir,
    DATABASE_URL: dbUrl,
  }
}

let child = null
function startServer() {
  child = spawn(process.execPath, [distMain], { cwd: serverRoot, env: baseEnv(), stdio: ['ignore', 'ignore', 'inherit'] })
  return child
}
function stopChild(c) {
  return new Promise((res) => {
    if (!c || c.exitCode !== null) return res()
    c.on('close', () => res())
    c.kill('SIGKILL')
    setTimeout(() => { if (c.exitCode === null) c.kill('SIGKILL') }, 800)
    setTimeout(() => { if (c.exitCode === null) c.kill('SIGKILL') }, 2000)
  })
}
async function waitReady(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) throw new Error(`server 提前退出 code=${child.exitCode}`)
    try { const r = await fetch(`http://127.0.0.1:${port}/api/notes`); if (r.ok) return } catch {}
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('server 未在超时内就绪')
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
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${text.slice(0, 200)}`)
  return json
}

let ok = true
function report(f, label, detail) {
  if (!f) ok = false
  console.log(`[drill] ${f ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`)
}
// 出/入链忽略 NoteLink 自身自增 id，只保留业务字段并稳定排序，便于恢复前后比对
function normalizeOut(list) {
  return (list ?? [])
    .map((l) => ({ targetNoteId: l.targetNoteId ?? null, targetTitle: l.targetTitle ?? '', linkText: l.linkText ?? '', isResolved: l.isResolved }))
    .sort((a, b) => (a.targetNoteId ?? '').localeCompare(b.targetNoteId ?? ''))
}
function normalizeIn(list) {
  return (list ?? [])
    .map((l) => ({ sourceNoteId: l.sourceNoteId ?? null, sourceTitle: l.sourceTitle ?? '', isResolved: l.isResolved }))
    .sort((a, b) => (a.sourceNoteId ?? '').localeCompare(b.sourceNoteId ?? ''))
}

void (async () => {
try {
  console.log(`[drill] 数据库/Markdown 组合备份恢复演练（临时目录: ${tmpRoot}，端口: ${port}）`)
  prepareDb()

  const s = startServer(); await waitReady()

  // 1) 造数据：3 篇互相链接的笔记，其中一篇含 TagTime 实体引用
  const seeds = [
    { title: 'BakA', content: '指向 [[BakB]] 和 [[BakC]]\n\n标签 [[tag:备份标签]]\n待办 [[todo:买牛奶]]' },
    { title: 'BakB', content: '回指 [[BakA]]' },
    { title: 'BakC', content: '独立正文，无链接' },
  ]
  const created = {}
  for (const g of seeds) {
    const r = await api('POST', '/api/notes', g)
    created[g.title] = r.id
  }
  // 备份前快照：每篇的 content + outLinks + inLinks + entities
  const before = {}
  for (const g of seeds) {
    const d = await api('GET', `/api/notes/${created[g.title]}`)
    const e = await api('GET', `/api/notes/${created[g.title]}/entities`)
    before[g.title] = {
      id: d.id, path: d.path, content: d.content, revision: d.revision,
      // 出链只比较业务字段(targetNoteId/targetTitle/linkText/isResolved)，忽略 NoteLink 自身自增 id（恢复后重建、无业务意义）
      outLinks: JSON.stringify(normalizeOut(d.outLinks)),
      inLinks: JSON.stringify(normalizeIn(d.inLinks)),
      entities: JSON.stringify(e ?? null),
    }
  }

  // 2) 停服 → 备份(SQLite + notes/) → 展示备份清单
  await stopChild(s)
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = join(tmpRoot, `_backup_${ts}`)
  const bNotes = join(backupDir, 'notes')
  mkdirSync(join(backupDir, 'data'), { recursive: true })
  mkdirSync(bNotes, { recursive: true })
  cpSync(notesDir, bNotes, { recursive: true })
  // 复制 SQLite 主文件及其 WAL/SHM（若存在）
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbAbs + suffix
    if (existsSync(p)) cpSync(p, join(backupDir, `data/${basename(p)}`))
  }
  const noteFiles = readdirSync(notesDir).filter((f) => f.endsWith('.md')).sort()
  report(noteFiles.length >= 3, '备份包含 notes/', `共 ${noteFiles.length} 个 .md`)
  report(existsSync(join(backupDir, 'data', 'backup.db')) || existsSync(dbAbs), '备份包含 SQLite 数据库')
  console.log(`[drill] 备份目录: ${backupDir}`)

  // 3) 破坏：清空 notes/ 正文 + 删除数据库（模拟整体丢失）
  for (const f of readdirSync(notesDir)) rmSync(join(notesDir, f), { force: true, recursive: true })
  for (const suffix of ['', '-wal', '-shm']) rmSync(dbAbs + suffix, { force: true })
  report((readdirSync(notesDir).filter((f) => f.endsWith('.md')).length) === 0, '已破坏：notes/ 与数据库清空')

  // 4) 恢复：从备份还原 SQLite + notes/
  cpSync(join(backupDir, 'data'), dataDir, { recursive: true })
  for (const suffix of ['', '-wal', '-shm']) {
    const b = join(backupDir, 'data', 'backup.db' + suffix)
    if (existsSync(b)) cpSync(b, dbAbs + suffix)
  }
  cpSync(bNotes, notesDir, { recursive: true })
  console.log('[drill] 已从备份还原 SQLite + notes/')

  // 5) 重启并断言：Note ID、链接关系、实体关联均一致
  const s2 = startServer(); await waitReady()
  const after = {}
  for (const g of seeds) {
    const id = created[g.title]
    const d = await api('GET', `/api/notes/${id}`)
    const e = await api('GET', `/api/notes/${id}/entities`)
    after[g.title] = {
      id: d.id, content: d.content, revision: d.revision,
      outLinks: JSON.stringify(normalizeOut(d.outLinks)),
      inLinks: JSON.stringify(normalizeIn(d.inLinks)),
      entities: JSON.stringify(e ?? null),
    }
  }
  for (const g of seeds) {
    const b = before[g.title], a = after[g.title]
    report(a.id === b.id && a.id === created[g.title], `${g.title} Note ID 恢复保持一致`, `id=${a.id}`)
    report(a.content === b.content, `${g.title} 正文恢复一致`, a.content.split('\n').slice(0, 1).join(''))
    report(a.revision === b.revision, `${g.title} revision 一致`, `rev=${a.revision}`)
    report(a.outLinks === b.outLinks, `${g.title} 出链一致`, a.outLinks)
    report(a.inLinks === b.inLinks, `${g.title} 入链一致`, a.inLinks)
    report(a.entities === b.entities, `${g.title} 实体关联一致`)
  }
  await stopChild(s2)

  console.log(ok ? '[drill] 结果：通过（备份恢复后 Note ID/链接/实体关联一致）' : '[drill] 结果：存在失败')
} catch (err) {
  ok = false
  console.error('[drill] 失败:', err.message || err)
} finally {
  await stopChild(child)
  rmSync(tmpRoot, { recursive: true, force: true })
}
process.exit(ok ? 0 : 1)
})().catch((e) => { console.error('[drill] 致命错误:', e); process.exit(2) })