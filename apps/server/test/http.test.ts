import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import noteRoutes from '../src/routes/notes.js'

const serverRoot = dirname(dirname(fileURLToPath(import.meta.url))) // apps/server
const tmpRoot = mkdtempSync(join(tmpdir(), 'tt-http-'))
const notesDir = join(tmpRoot, 'notes')
process.env.DATA_DIR = join(tmpRoot, 'data')
process.env.NOTES_DIR = notesDir
process.env.DATABASE_URL = `file:${join(tmpRoot, 'http.db').replace(/\\/g, '/')}`

execSync('node node_modules/prisma/build/index.js db push --skip-generate --schema src/schema.prisma', {
  cwd: serverRoot,
  env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
  stdio: 'pipe',
})

let prisma: typeof import('../src/db.js').default
let api: ReturnType<typeof makeApi>
before(async () => {
  prisma = (await import('../src/db.js')).default
  api = await makeApi()
})
after(async () => {
  await prisma?.$disconnect()
  await api?.app.close()
  rmSync(tmpRoot, { recursive: true, force: true })
})

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<T>((_, rej) => {
    timer = setTimeout(() => rej(new Error('请求挂起(超时)')), ms)
  })
  return Promise.race([guard, p.finally(() => clearTimeout(timer))])
}

async function makeApi() {
  const app = Fastify({ logger: false })
  await app.register(websocket)
  await app.register(noteRoutes, { prefix: '/api/notes' })
  await app.ready()
  const post = (payload: unknown) => app.inject({ method: 'POST', url: '/api/notes', payload })
  const patch = (id: string, payload: unknown) => app.inject({ method: 'PATCH', url: `/api/notes/${id}`, payload })
  const put = (id: string, payload: unknown) => app.inject({ method: 'PUT', url: `/api/notes/${id}`, payload })
  const get = (id: string) => app.inject({ method: 'GET', url: `/api/notes/${id}` })
  const del = (id: string) => app.inject({ method: 'DELETE', url: `/api/notes/${id}` })
  return { app, post, patch, put, get, del }
}

test('HTTP：带别名链接的笔记经 PATCH 重命名后，其它笔记正文被改写且关系重建', async () => {
  const r1 = await api.post({ title: 'HttpSrc', content: '正文' })
  const r2 = await api.post({ title: 'HttpLink', content: '见 [[HttpSrc]] 和 [[HttpSrc|别名]]' })
  assert.equal(r1.statusCode, 201)
  assert.equal(r2.statusCode, 201)
  const src = r1.json()
  const link = r2.json()

  const before = (await api.get(link.id)).json()
  assert.equal(before.outLinks[0].isResolved, true)

  const ren = (await api.patch(src.id, { title: 'HttpSrcRenamed' })).json()
  assert.equal(ren.path, 'HttpSrcRenamed.md')

  const after = (await api.get(link.id)).json()
  assert.ok(after.content.includes('[[HttpSrcRenamed]]'), '无别名旧链接被改写')
  assert.ok(after.content.includes('[[HttpSrcRenamed|别名]]'), '带别名旧链接被改写')
  assert.ok(!after.content.includes('[[HttpSrc]]'), '旧标题不应残留')
  assert.equal(after.outLinks[0].isResolved, true)
  assert.equal(after.outLinks[0].targetTitle, 'HttpSrcRenamed')

  await api.del(src.id)
  await api.del(link.id)
})

test('HTTP：互相链接的两篇笔记并发重命名不死锁，Note ID 不变、正文链接一致', async () => {
  const a = (await api.post({ title: 'RenA', content: '指向 [[RenB]]' })).json()
  const b = (await api.post({ title: 'RenB', content: '指向 [[RenA]]' })).json()

  const [ra, rb] = await withTimeout(
    Promise.all([
      api.patch(a.id, { title: 'RenA2' }),
      api.patch(b.id, { title: 'RenB2' }),
    ]),
    15000,
  )
  assert.ok(ra.statusCode === 200 || ra.statusCode === 201, `重命名 A 应成功，得到 ${ra.statusCode}`)
  assert.ok(rb.statusCode === 200 || rb.statusCode === 201, `重命名 B 应成功，得到 ${rb.statusCode}`)

  // Note ID 保持不变
  const ta = (await api.get(a.id)).json()
  const tb = (await api.get(b.id)).json()
  assert.equal(ta.id, a.id)
  assert.equal(tb.id, b.id)
  assert.equal(ta.title, 'RenA2')
  assert.equal(tb.title, 'RenB2')
  // 正文交叉改写一致
  assert.ok(ta.content.includes('[[RenB2]]'), 'A 正文应指向新的 B 标题')
  assert.ok(!ta.content.includes('[[RenB]]'), 'A 不应残留旧 B 标题')
  assert.ok(tb.content.includes('[[RenA2]]'), 'B 正文应指向新的 A 标题')
  assert.ok(!tb.content.includes('[[RenA]]'), 'B 不应残留旧 A 标题')
  // 关系均解析
  assert.equal(ta.outLinks[0].isResolved, true)
  assert.equal(tb.outLinks[0].isResolved, true)

  await api.del(a.id)
  await api.del(b.id)
})

test('HTTP：PUT 携带过期 revision 返回 409 版本冲突，绝不做静默覆盖', async () => {
  const n = (await api.post({ title: 'Conf', content: 'v1' })).json()
  const detail = (await api.get(n.id)).json()
  const stale = { content: '来自旧版本', revision: detail.revision + 99 }
  const conflict = await api.put(n.id, stale)
  assert.equal(conflict.statusCode, 409)
  // 服务器内容未被覆盖
  const cur = (await api.get(n.id)).json()
  assert.equal(cur.content, 'v1')
  // 用最新 revision 保存成功
  const ok = await api.put(n.id, { content: 'v2', revision: cur.revision })
  assert.equal(ok.statusCode, 200)
  await api.del(n.id)
})

test('HTTP：重命名改写后用户再 PUT，既不丢改写也不丢用户新增内容', async () => {
  const nx = (await api.post({ title: 'NX', content: 'x' })).json()
  const ny = (await api.post({ title: 'NY', content: '见 [[NX]]' })).json()

  await api.patch(nx.id, { title: 'NX2' })
  const after = (await api.get(ny.id)).json()
  assert.ok(after.content.includes('[[NX2]]'), '改写应先生效')

  const put = await api.put(ny.id, { content: '补充 [[NX2]] 内容', revision: after.revision })
  assert.equal(put.statusCode, 200)
  const final = (await api.get(ny.id)).json()
  assert.equal(final.content, '补充 [[NX2]] 内容')
  assert.equal(final.outLinks[0].isResolved, true)
  assert.equal(final.outLinks[0].targetTitle, 'NX2')

  await api.del(nx.id)
  await api.del(ny.id)
})