import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import noteRoutes from '../src/routes/notes.js'
import { CONTENT_LIMITS } from '../src/config.js'
import { pushTestSchema } from './test-db.js'

const serverRoot = dirname(dirname(fileURLToPath(import.meta.url))) // apps/server
const tmpRoot = mkdtempSync(join(tmpdir(), 'tt-http-'))
let notesDir = join(tmpRoot, 'notes')
process.env.DATA_DIR = join(tmpRoot, 'data')
process.env.NOTES_DIR = notesDir
process.env.DATABASE_URL = `file:${join(tmpRoot, 'http.db').replace(/\\/g, '/')}`

pushTestSchema(serverRoot, process.env.DATABASE_URL)

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
  const folders = () => app.inject({ method: 'GET', url: '/api/notes/folders' })
  const postFolder = (payload: unknown) => app.inject({ method: 'POST', url: '/api/notes/folders', payload })
  const deleteFolder = (path: string) => app.inject({ method: 'DELETE', url: `/api/notes/folders?path=${encodeURIComponent(path)}` })
  return { app, post, patch, put, get, del, folders, postFolder, deleteFolder }
}

test('HTTP：创建多级文件夹，在文件夹中新建并移动笔记，重命名保留目录', async () => {
  const bad = await api.postFolder({ path: '../escape' })
  assert.equal(bad.statusCode, 400)

  const made = await api.postFolder({ path: '工作/项目' })
  assert.equal(made.statusCode, 201)
  assert.equal(made.json().path, '工作/项目')

  const createdResponse = await api.post({ title: 'FolderNote', content: '# 标题\n\n- [ ] 任务', folder: '工作/项目' })
  assert.equal(createdResponse.statusCode, 201)
  const created = createdResponse.json()
  assert.equal(created.path, '工作/项目/FolderNote.md')

  const nonEmpty = await api.deleteFolder('工作/项目')
  assert.equal(nonEmpty.statusCode, 409)

  assert.equal((await api.postFolder({ path: '归档' })).statusCode, 201)
  const moved = await api.patch(created.id, { folder: '归档' })
  assert.equal(moved.statusCode, 200)
  assert.equal(moved.json().path, '归档/FolderNote.md')

  const renamed = await api.patch(created.id, { title: 'FolderNoteRenamed' })
  assert.equal(renamed.statusCode, 200)
  assert.equal(renamed.json().path, '归档/FolderNoteRenamed.md')
  const detail = (await api.get(created.id)).json()
  assert.ok(detail.content.includes('- [ ] 任务'))

  const listed = (await api.folders()).json().folders as string[]
  assert.ok(listed.includes('工作/项目'))
  assert.ok(listed.includes('归档'))

  await api.del(created.id)
  assert.equal((await api.deleteFolder('归档')).statusCode, 200)
  assert.equal((await api.deleteFolder('工作/项目')).statusCode, 200)
  assert.equal((await api.deleteFolder('工作')).statusCode, 200)
})

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

test('HTTP：局部关系图只返回范围内的双向邻居', async () => {
  const a = (await api.post({ title: 'GraphA', content: '指向 [[GraphB]]' })).json()
  const b = (await api.post({ title: 'GraphB', content: '指向 [[GraphC]]' })).json()
  const c = (await api.post({ title: 'GraphC', content: '孤立' })).json()
  const graph = await api.app.inject({ method: 'GET', url: `/api/notes/${a.id}/graph?depth=2` })
  assert.equal(graph.statusCode, 200)
  const data = graph.json()
  assert.deepEqual(new Set(data.nodes.map((n: { title: string }) => n.title)), new Set(['GraphA', 'GraphB', 'GraphC']))
  assert.ok(data.links.some((l: { source: string; target: string }) => l.source === a.id && l.target === b.id))
  assert.ok(data.links.some((l: { source: string; target: string }) => l.source === b.id && l.target === c.id))
  await api.del(a.id)
  await api.del(b.id)
  await api.del(c.id)
})

test('HTTP：全局关系图尊重调用方设置的节点上限', async () => {
  const first = (await api.post({ title: 'GraphLimitA', content: '孤立' })).json()
  const second = (await api.post({ title: 'GraphLimitB', content: '孤立' })).json()
  const response = await api.app.inject({ method: 'GET', url: '/api/notes/graph?limit=1' })
  assert.equal(response.statusCode, 200)
  const data = response.json()
  assert.equal(data.nodes.filter((node: { isUnresolved?: boolean }) => !node.isUnresolved).length, 1)
  await api.del(first.id)
  await api.del(second.id)
})

test('HTTP：笔记标题和正文长度限制返回兼容的 error 字段', async () => {
  const tooLongTitle = await api.post({
    title: 'x'.repeat(CONTENT_LIMITS.NOTE_TITLE + 1),
    content: 'test',
  })
  assert.equal(tooLongTitle.statusCode, 400)
  assert.match(tooLongTitle.json().error, /标题/)

  const tooLongContent = await api.post({
    title: `TooLongContent-${Date.now()}`,
    content: 'x'.repeat(CONTENT_LIMITS.NOTE_CONTENT + 1),
  })
  assert.equal(tooLongContent.statusCode, 400)
  assert.match(tooLongContent.json().error, /内容/)

  const exactTitle = 'x'.repeat(CONTENT_LIMITS.NOTE_TITLE)
  const exact = await api.post({ title: exactTitle, content: '边界值' })
  assert.equal(exact.statusCode, 201)
  await api.del(exact.json().id)
})

test('HTTP：Windows 保留设备名带扩展名时仍能安全创建笔记', async () => {
  const response = await api.post({ title: 'CON.txt', content: '设备名兼容' })
  assert.equal(response.statusCode, 201)
  assert.match(response.json().path, /_CON\.txt\.md$/)
  await api.del(response.json().id)
})

test('HTTP：笔记查询参数重复时返回 400', async () => {
  const response = await api.app.inject({
    method: 'GET',
    url: '/api/notes?q=one&q=two',
  })
  assert.equal(response.statusCode, 400)
})

test('HTTP：删除文件夹时拒绝重复 path 参数', async () => {
  const response = await api.app.inject({
    method: 'DELETE',
    url: '/api/notes/folders?path=one&path=two',
  })
  assert.equal(response.statusCode, 400)
})
