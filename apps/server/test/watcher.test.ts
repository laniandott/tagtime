import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import websocket from '@fastify/websocket'

// 必须先于任何 src 模块加载前设置环境，config/db 在 import 时读取
const serverRoot = dirname(dirname(fileURLToPath(import.meta.url))) // apps/server
const tmpRoot = mkdtempSync(join(tmpdir(), 'tt-watch-'))
const notesDir = join(tmpRoot, 'notes')
process.env.DATA_DIR = join(tmpRoot, 'data')
process.env.NOTES_DIR = notesDir
process.env.DATABASE_URL = `file:${join(tmpRoot, 'watch.db').replace(/\\/g, '/')}`

execSync('node node_modules/prisma/build/index.js db push --skip-generate --schema src/schema.prisma', {
  cwd: serverRoot,
  env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
  stdio: 'pipe',
})

// 动态导入，确保上面的环境变量已生效
const prisma = (await import('../src/db.js')).default
const { trackNotesDirectory } = await import('../src/notes-watcher.js')
const noteRoutes = (await import('../src/routes/notes.js')).default
const { suspendWatcherPaths, isWatcherPathSuspended } = await import('../src/notes.js')

let app: ReturnType<typeof Fastify>
let watcher: Awaited<ReturnType<typeof trackNotesDirectory>>
let didTearDown = false

async function makeApi() {
  app = Fastify({ logger: false })
  await app.register(websocket)
  await app.register(noteRoutes, { prefix: '/api/notes' })
  await app.ready()
  const post = (payload: unknown) => app.inject({ method: 'POST', url: '/api/notes', payload })
  const patch = (id: string, payload: unknown) => app.inject({ method: 'PATCH', url: `/api/notes/${id}`, payload })
  const del = (id: string) => app.inject({ method: 'DELETE', url: `/api/notes/${id}` })
  return { post, patch, del }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

before(async () => {
  // 启动真实 Chokidar 监听 NOTES_DIR，覆盖“watcher 事件先于 API 数据库更新”的顺序
  watcher = trackNotesDirectory()
})

after(async () => {
  didTearDown = true
  await watcher?.close()
  await prisma?.$disconnect()
  await app?.close()
  rmSync(tmpRoot, { recursive: true, force: true })
})

test('暂停机制：suspendWatcherPaths 后 isWatcherPathSuspended 为真，到期后自动失效', async () => {
  suspendWatcherPaths(['x.md'], 100)
  assert.ok(isWatcherPathSuspended('x.md'))
  await sleep(200)
  assert.ok(!isWatcherPathSuspended('x.md'))
})

test('真实 watcher：API 重命名期间不建重复索引、不误删旧索引，Note ID 保持不变', async () => {
  const api = await makeApi()
  const created = await api.post({ title: 'WatchA', content: '正文 hi' })
  assert.ok(created.statusCode === 200 || created.statusCode === 201, `创建应成功，得到 ${created.statusCode}`)
  const note = created.json()
  const id = note.id

  // 重命名：会产生 新路径 add + 旧路径 unlink 两类文件事件；暂停窗口(3s)应覆盖 watcher 防抖与 db 更新完成
  const renamed = await api.patch(id, { title: 'WatchB' })
  assert.ok(renamed.statusCode === 200 || renamed.statusCode === 201, `重命名应成功，得到 ${renamed.statusCode}`)

  // 暂停期内：数据库应只存在新路径一条且 ID 不变，旧路径已不存在
  const pathsDuring = await prisma.note.findMany({ where: { path: 'WatchB.md' } })
  assert.equal(pathsDuring.length, 1, `新路径应只有一条索引，实际 ${pathsDuring.length}`)
  assert.equal(pathsDuring[0].id, id, 'Note ID 应保持不变')
  const oldDuring = await prisma.note.findMany({ where: { path: 'WatchA.md' } })
  assert.equal(oldDuring.length, 0, '旧路径索引应被重命名迁移，不应残留')

  // 等待 watcher 防抖(500ms)+awaitWriteFinish(400ms)+暂停窗口(3000ms)全部过去，
  // 再确认没有因事件迟到而产生的重复索引
  await sleep(3200)
  const pathsAfter = await prisma.note.findMany({ where: { path: 'WatchB.md' } })
  assert.equal(pathsAfter.length, 1, `暂停解除后新路径仍应只有一条索引，实际 ${pathsAfter.length}`)
  assert.equal(pathsAfter[0].id, id, '暂停解除后 Note ID 仍应不变')
  assert.equal(pathsAfter[0].title, 'WatchB')
  const oldAfter = await prisma.note.findMany({ where: { path: 'WatchA.md' } })
  assert.equal(oldAfter.length, 0, '旧路径索引在暂停解除后仍不应出现')

  // 清理：删除该笔记，避免残留影响后续
  await api.del(id)
})