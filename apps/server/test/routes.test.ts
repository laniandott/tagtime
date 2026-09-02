import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import { pushTestSchema } from './test-db.js'
import { CONTENT_LIMITS } from '../src/config.js'

const serverRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const tmpRoot = mkdtempSync(join(tmpdir(), 'tt-routes-'))
process.env.DATA_DIR = join(tmpRoot, 'data')
process.env.NOTES_DIR = join(tmpRoot, 'notes')
process.env.DATABASE_URL = `file:${join(tmpRoot, 'routes.db').replace(/\\/g, '/')}`
pushTestSchema(serverRoot, process.env.DATABASE_URL)

let prisma: typeof import('../src/db.js').default
let app: ReturnType<typeof Fastify>
let uploadDir: string

before(async () => {
  prisma = (await import('../src/db.js')).default
  const memoRoutes = (await import('../src/routes/memos.js')).default
  const timerRoutes = (await import('../src/routes/timer.js')).default
  const statsRoutes = (await import('../src/routes/stats.js')).default
  const categoryRoutes = (await import('../src/routes/categories.js')).default
  const tagRoutes = (await import('../src/routes/tags.js')).default
  const todoRoutes = (await import('../src/routes/todos.js')).default
  const goalRoutes = (await import('../src/routes/goals.js')).default
  const calendarRoutes = (await import('../src/routes/calendar.js')).default
  const calendarsRoutes = (await import('../src/routes/calendars.js')).default
  uploadDir = (await import('../src/config.js')).UPLOAD_DIR

  app = Fastify({ logger: false })
  await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024 } })
  await app.register(memoRoutes, { prefix: '/api/memos' })
  await app.register(timerRoutes, { prefix: '/api/timer' })
  await app.register(statsRoutes, { prefix: '/api/stats' })
  await app.register(categoryRoutes, { prefix: '/api/categories' })
  await app.register(tagRoutes, { prefix: '/api/tags' })
  await app.register(todoRoutes, { prefix: '/api/todos' })
  await app.register(goalRoutes, { prefix: '/api/goals' })
  await app.register(calendarRoutes, { prefix: '/api/calendar' })
  await app.register(calendarsRoutes, { prefix: '/api/calendars' })
  await app.ready()
})

after(async () => {
  await app?.close()
  await prisma?.$disconnect()
  rmSync(tmpRoot, { recursive: true, force: true })
})

test('日记附件：拒绝越界路径，编辑保留旧文件，只清理移除项', async () => {
  const keepPath = join(uploadDir, 'keep.jpg')
  const removePath = join(uploadDir, 'remove.jpg')
  writeFileSync(keepPath, 'keep')
  writeFileSync(removePath, 'remove')

  const keep = { filename: 'keep.jpg', path: '/uploads/keep.jpg', mimeType: 'image/jpeg', size: 1 }
  const remove = { filename: 'remove.jpg', path: '/uploads/remove.jpg', mimeType: 'image/jpeg', size: 1 }
  const createdResponse = await app.inject({
    method: 'POST',
    url: '/api/memos',
    payload: { content: 'before', attachments: [keep] },
  })
  assert.equal(createdResponse.statusCode, 200)
  const created = createdResponse.json()

  const unchanged = await app.inject({
    method: 'PUT',
    url: `/api/memos/${created.id}`,
    payload: { content: 'after', attachments: [keep] },
  })
  assert.equal(unchanged.statusCode, 200)
  assert.ok(existsSync(keepPath), '只编辑文字时旧附件必须保留')
  assert.equal((await prisma.attachment.findMany({ where: { memoId: created.id } })).length, 1)

  assert.equal((await app.inject({
    method: 'PUT',
    url: `/api/memos/${created.id}`,
    payload: { attachments: [keep, remove] },
  })).statusCode, 200)
  assert.equal((await app.inject({
    method: 'PUT',
    url: `/api/memos/${created.id}`,
    payload: { attachments: [keep] },
  })).statusCode, 200)
  assert.ok(existsSync(keepPath))
  assert.ok(!existsSync(removePath), '移除的附件应在事务提交后清理')

  const traversal = await app.inject({
    method: 'POST',
    url: '/api/memos',
    payload: {
      content: 'attack',
      attachments: [{ filename: 'db', path: '/uploads/../routes.db', mimeType: 'x', size: 1 }],
    },
  })
  assert.equal(traversal.statusCode, 400)
  assert.ok(existsSync(join(tmpRoot, 'routes.db')))

  assert.equal((await app.inject({ method: 'DELETE', url: `/api/memos/${created.id}` })).statusCode, 200)
  assert.ok(!existsSync(keepPath))

  // 数组中途出现无效附件时，前面已经处理的文件也不能成为孤儿文件。
  const partialPath = join(uploadDir, 'partial.jpg')
  writeFileSync(partialPath, 'partial')
  const partial = await app.inject({
    method: 'POST',
    url: '/api/memos',
    payload: {
      content: 'partial attachment failure',
      attachments: [
        { filename: 'partial.jpg', path: '/uploads/partial.jpg', mimeType: 'image/jpeg', size: 7 },
        { filename: 'missing.jpg', path: '/uploads/missing.jpg', mimeType: 'image/jpeg', size: 7 },
      ],
    },
  })
  assert.equal(partial.statusCode, 400)
  assert.ok(!existsSync(partialPath), '部分校验失败时已处理的附件也应清理')
})

test('日记附件：拒绝指向 uploads 外部的符号链接', async () => {
  const outside = join(tmpRoot, 'outside-secret.txt')
  const link = join(uploadDir, 'outside-link.jpg')
  writeFileSync(outside, 'secret')
  try {
    symlinkSync(outside, link)
  } catch {
    // Windows 未授予创建符号链接权限时跳过该平台专属回归测试。
    rmSync(outside, { force: true })
    return
  }
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/memos',
      payload: {
        content: '拒绝链接附件',
        attachments: [{ filename: 'outside-link.jpg', path: '/uploads/outside-link.jpg', mimeType: 'image/jpeg', size: 6 }],
      },
    })
    assert.equal(response.statusCode, 400)
    assert.match(response.json().error, /符号链接|越界/)
  } finally {
    rmSync(link, { force: true })
    rmSync(outside, { force: true })
  }
})

test('日记附件：编辑失败时清理本次请求留下的孤儿文件', async () => {
  const orphanPath = join(uploadDir, 'orphan-on-update.jpg')
  writeFileSync(orphanPath, 'orphan')
  const response = await app.inject({
    method: 'PUT',
    url: '/api/memos/not-found',
    payload: {
      content: '更新失败',
      attachments: [{ filename: 'orphan.jpg', path: '/uploads/orphan-on-update.jpg', mimeType: 'image/jpeg', size: 6 }],
    },
  })
  assert.equal(response.statusCode, 404)
  assert.ok(!existsSync(orphanPath), '编辑失败时新附件不应残留')
})

test('统计与计时：跨午夜按天拆分，拒绝负时长和无效日期', async () => {
  const category = await prisma.category.create({ data: { name: '测试分类' } })
  const tag = await prisma.tag.create({ data: { name: '跨日', categoryId: category.id } })
  const firstDay = new Date(2026, 7, 30, 23, 30, 0)
  const secondDay = new Date(2026, 7, 31, 0, 30, 0)
  const entry = await prisma.timeEntry.create({
    data: { tagId: tag.id, startTime: firstDay, endTime: secondDay },
  })

  const rangeStart = new Date(2026, 7, 30, 0, 0, 0)
  const rangeEnd = new Date(2026, 7, 31, 23, 59, 59, 999)
  const dailyResponse = await app.inject({
    method: 'GET',
    url: `/api/stats/daily?from=${encodeURIComponent(rangeStart.toISOString())}&to=${encodeURIComponent(rangeEnd.toISOString())}`,
  })
  assert.equal(dailyResponse.statusCode, 200)
  const daily = dailyResponse.json()
  assert.equal(daily.length, 2)
  assert.equal(daily[0].total, 30 * 60 * 1000)
  assert.equal(daily[1].total, 30 * 60 * 1000)

  const longRange = await app.inject({ method: 'GET', url: '/api/stats/daily?days=3660' })
  assert.equal(longRange.statusCode, 200)
  assert.equal(longRange.json().length, 3660)

  const secondDayStart = new Date(2026, 7, 31, 0, 0, 0)
  const secondDayEnd = new Date(2026, 7, 31, 1, 0, 0)
  const byTag = (await app.inject({
    method: 'GET',
    url: `/api/stats/by-tag?from=${encodeURIComponent(secondDayStart.toISOString())}&to=${encodeURIComponent(secondDayEnd.toISOString())}`,
  })).json()
  assert.equal(byTag[0].ms, 30 * 60 * 1000)

  const negative = await app.inject({
    method: 'PUT',
    url: `/api/timer/${entry.id}`,
    payload: { endTime: new Date(2026, 7, 30, 22, 0, 0).toISOString() },
  })
  assert.equal(negative.statusCode, 400)
  assert.equal((await prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } })).endTime?.getTime(), secondDay.getTime())

  const invalid = await app.inject({
    method: 'POST',
    url: '/api/timer/manual',
    payload: { tagId: tag.id, startTime: 'not-a-date', endTime: 'still-not-a-date' },
  })
  assert.equal(invalid.statusCode, 400)
})

test('HTTP：Memo 和计时备注长度限制返回 400', async () => {
  const tooLongMemo = await app.inject({
    method: 'POST',
    url: '/api/memos',
    payload: { content: 'x'.repeat(CONTENT_LIMITS.MEMO_CONTENT + 1) },
  })
  assert.equal(tooLongMemo.statusCode, 400)
  assert.match(tooLongMemo.json().error, /内容/)

  const tooLongNote = await app.inject({
    method: 'POST',
    url: '/api/timer/start',
    payload: { tagId: 'missing-tag', note: 'x'.repeat(CONTENT_LIMITS.TIMER_NOTE + 1) },
  })
  assert.equal(tooLongNote.statusCode, 400)
  assert.match(tooLongNote.json().error, /备注/)
})

test('边界校验：重复查询参数返回 400，不把数组传给 Prisma', async () => {
  assert.equal((await app.inject({
    method: 'GET', url: '/api/stats/summary?categoryId=a&categoryId=b',
  })).statusCode, 400)
  assert.equal((await app.inject({
    method: 'GET', url: '/api/memos?standaloneOnly=true&standaloneOnly=false',
  })).statusCode, 400)
  assert.equal((await app.inject({
    method: 'GET', url: '/api/calendar/feed.ics?tagId=a&tagId=b',
  })).statusCode, 400)
  assert.equal((await app.inject({
    method: 'GET', url: '/api/calendars/external-events?from=2026-01-01&from=2026-01-02',
  })).statusCode, 400)
})

test('Memo 编辑：拒绝把内容改成空白', async () => {
  const created = await app.inject({
    method: 'POST', url: '/api/memos', payload: { content: '保留内容' },
  })
  assert.equal(created.statusCode, 200)
  const memo = created.json()
  const updated = await app.inject({
    method: 'PUT', url: `/api/memos/${memo.id}`, payload: { content: '  \n  ' },
  })
  assert.equal(updated.statusCode, 400)
  const current = await prisma.memo.findUniqueOrThrow({ where: { id: memo.id } })
  assert.equal(current.content, '保留内容')
  await prisma.memo.delete({ where: { id: memo.id } })
})

test('iCalendar：控制字符不会注入新的内容行', async () => {
  const tag = await prisma.tag.create({ data: { name: `导出\r\nX-INJECTED: yes-${Date.now()}` } })
  const entry = await prisma.timeEntry.create({
    data: { tagId: tag.id, startTime: new Date(Date.now() - 60_000), endTime: new Date() },
  })
  const response = await app.inject({ method: 'GET', url: '/api/calendar/feed.ics?all=true' })
  assert.equal(response.statusCode, 200)
  assert.doesNotMatch(response.body, /\r\nX-INJECTED:/)
  await prisma.timeEntry.delete({ where: { id: entry.id } })
  await prisma.tag.delete({ where: { id: tag.id } })
})

test('边界校验：非法日期、引用和查询参数返回 400/404，而不是 500', async () => {
  assert.equal((await app.inject({
    method: 'GET', url: '/api/timer?from=bad-date',
  })).statusCode, 400)
  assert.equal((await app.inject({
    method: 'GET', url: '/api/memos?days=0',
  })).statusCode, 400)
  assert.equal((await app.inject({
    method: 'POST', url: '/api/timer/start', payload: { tagId: 'missing-tag' },
  })).statusCode, 404)
  assert.equal((await app.inject({
    method: 'POST', url: '/api/todos', payload: { title: 'bad due date', dueDate: 'not-a-date' },
  })).statusCode, 400)
  assert.equal((await app.inject({
    method: 'GET', url: '/api/calendar/feed.ics?days=-1',
  })).statusCode, 400)

  assert.equal((await app.inject({
    method: 'POST', url: '/api/memos', payload: { content: 'bad date', createdAt: 0 },
  })).statusCode, 400)
  assert.equal((await app.inject({
    method: 'POST', url: '/api/todos', payload: { title: 'numeric due date', dueDate: 0 },
  })).statusCode, 400)
})

test('目标更新：只改标题不会清空自定义周期；非法目标值被拒绝', async () => {
  const tag = await prisma.tag.create({ data: { name: `目标校验-${Date.now()}` } })
  const created = await app.inject({
    method: 'POST',
    url: '/api/goals',
    payload: { tagId: tag.id, title: '自定义周期', type: 'count', target: 3, period: 'custom', periodDays: 14 },
  })
  assert.equal(created.statusCode, 200)
  const goal = created.json()
  const renamed = await app.inject({ method: 'PUT', url: `/api/goals/${goal.id}`, payload: { title: '改名' } })
  assert.equal(renamed.statusCode, 200)
  assert.equal(renamed.json().periodDays, 14)

  const invalid = await app.inject({ method: 'PUT', url: `/api/goals/${goal.id}`, payload: { target: 0 } })
  assert.equal(invalid.statusCode, 400)
  await prisma.goal.delete({ where: { id: goal.id } })
  await prisma.tag.delete({ where: { id: tag.id } })
})

test('标签：未分类同名标签也应被拒绝，避免实体链接歧义', async () => {
  const name = `重复未分类-${Date.now()}`
  const first = await app.inject({ method: 'POST', url: '/api/tags', payload: { name } })
  assert.equal(first.statusCode, 200)
  const duplicate = await app.inject({ method: 'POST', url: '/api/tags', payload: { name } })
  assert.equal(duplicate.statusCode, 409)
  const tag = first.json()
  await prisma.tag.delete({ where: { id: tag.id } })
})

test('更新分类/标签发生唯一键冲突时返回 409，而不是误报不存在', async () => {
  const categoryA = await prisma.category.create({ data: { name: `冲突分类A-${Date.now()}` } })
  const categoryB = await prisma.category.create({ data: { name: `冲突分类B-${Date.now()}` } })
  const categoryConflict = await app.inject({
    method: 'PUT', url: `/api/categories/${categoryA.id}`, payload: { name: categoryB.name },
  })
  assert.equal(categoryConflict.statusCode, 409)

  const tagA = await prisma.tag.create({ data: { name: `冲突标签A-${Date.now()}`, categoryId: categoryA.id } })
  const tagB = await prisma.tag.create({ data: { name: `冲突标签B-${Date.now()}`, categoryId: categoryA.id } })
  const tagConflict = await app.inject({
    method: 'PUT', url: `/api/tags/${tagA.id}`, payload: { name: tagB.name },
  })
  assert.equal(tagConflict.statusCode, 409)

  await prisma.tag.deleteMany({ where: { id: { in: [tagA.id, tagB.id] } } })
  await prisma.category.deleteMany({ where: { id: { in: [categoryA.id, categoryB.id] } } })
})

test('目标进度：跨周期的时长记录按交集计入，非法标签不会返回 500', async () => {
  const missing = await app.inject({
    method: 'POST',
    url: '/api/goals',
    payload: { tagId: 'missing-goal-tag', title: '无效标签' },
  })
  assert.equal(missing.statusCode, 404)

  const tooLong = await app.inject({
    method: 'POST',
    url: '/api/goals',
    payload: { tagId: 'missing-goal-tag', title: 'x'.repeat(201) },
  })
  assert.equal(tooLong.statusCode, 400)

  const tag = await prisma.tag.create({ data: { name: `目标跨周期-${Date.now()}` } })
  const goal = await prisma.goal.create({
    data: { tagId: tag.id, title: '跨日时长', type: 'time', target: 30, period: 'daily' },
  })
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const entryStart = new Date(todayStart.getTime() - 10 * 60 * 1000)
  const entryEnd = new Date(todayStart.getTime() + 10 * 60 * 1000)
  await prisma.timeEntry.create({
    data: {
      tagId: tag.id,
      startTime: entryStart,
      endTime: entryEnd,
    },
  })

  const response = await app.inject({ method: 'GET', url: '/api/goals' })
  assert.equal(response.statusCode, 200)
  const current = response.json().find((item: { id: string }) => item.id === goal.id)
  const expected = Math.floor(
    Math.max(0, Math.min(entryEnd.getTime(), Date.now()) - Math.max(entryStart.getTime(), todayStart.getTime())) / 60000,
  )
  assert.equal(current.current, expected)

  await prisma.goal.delete({ where: { id: goal.id } })
  await prisma.timeEntry.deleteMany({ where: { tagId: tag.id } })
  await prisma.tag.delete({ where: { id: tag.id } })
})

test('日历订阅：拒绝内网地址和 URL 中的明文凭据', async () => {
  const local = await app.inject({
    method: 'POST',
    url: '/api/calendars/subscriptions',
    payload: { name: 'local', url: 'http://127.0.0.1:3000/calendar.ics' },
  })
  assert.equal(local.statusCode, 400)
  const credentials = await app.inject({
    method: 'POST',
    url: '/api/calendars/subscriptions',
    payload: { name: 'credentials', url: 'https://user:password@example.com/calendar.ics' },
  })
  assert.equal(credentials.statusCode, 400)
  const ipv6Loopback = await app.inject({
    method: 'POST',
    url: '/api/calendars/subscriptions',
    payload: { name: 'ipv6-loopback', url: 'http://[::1]:3000/calendar.ics' },
  })
  assert.equal(ipv6Loopback.statusCode, 400)
})

test('日历订阅：修改 URL 或重新启用时清除旧同步时间', async () => {
  const sub = await prisma.calendarSubscription.create({
    data: { name: `缓存失效-${Date.now()}`, url: 'https://example.com/old.ics', active: false, lastSyncAt: new Date() },
  })
  const changed = await app.inject({
    method: 'PUT',
    url: `/api/calendars/subscriptions/${sub.id}`,
    payload: { url: 'https://example.com/new.ics' },
  })
  assert.equal(changed.statusCode, 200)
  assert.equal(changed.json().lastSyncAt, null)

  const reactivated = await app.inject({
    method: 'PUT',
    url: `/api/calendars/subscriptions/${sub.id}`,
    payload: { active: true },
  })
  assert.equal(reactivated.statusCode, 200)
  assert.equal(reactivated.json().lastSyncAt, null)
  await prisma.calendarSubscription.delete({ where: { id: sub.id } })
})

test('日历同步：订阅地址变更后，旧请求不能写回新缓存', async () => {
  const sub = await prisma.calendarSubscription.create({
    data: { name: `并发同步-${Date.now()}`, url: 'https://1.1.1.1/old.ics' },
  })
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:stale-sync-test',
    'DTSTART:20260901T000000Z',
    'DTEND:20260901T010000Z',
    'SUMMARY:旧地址事件',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')
  const originalFetch = globalThis.fetch
  let release!: (response: Response) => void
  let fetchStarted = false
  const pending = new Promise<Response>((resolve) => { release = resolve })
  globalThis.fetch = (async () => {
    fetchStarted = true
    return pending
  }) as typeof fetch
  try {
    const syncPromise = app.inject({ method: 'POST', url: `/api/calendars/subscriptions/${sub.id}/sync` })
    for (let i = 0; i < 50 && !fetchStarted; i++) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(fetchStarted, true)

    const changed = await app.inject({
      method: 'PUT',
      url: `/api/calendars/subscriptions/${sub.id}`,
      payload: { url: 'https://1.1.1.1/new.ics' },
    })
    assert.equal(changed.statusCode, 200)
    release(new Response(ics, { status: 200, headers: { 'content-type': 'text/calendar' } }))

    const response = await syncPromise
    assert.equal(response.statusCode, 502)
    assert.equal(await prisma.calendarEvent.count({ where: { subscriptionId: sub.id } }), 0)
    assert.equal((await prisma.calendarSubscription.findUniqueOrThrow({ where: { id: sub.id } })).lastSyncAt, null)
  } finally {
    globalThis.fetch = originalFetch
    await prisma.calendarSubscription.delete({ where: { id: sub.id } }).catch(() => {})
  }
})

test('日历同步：午夜开始的普通事件不应被误判为全天事件', async () => {
  const sub = await prisma.calendarSubscription.create({
    data: { name: `午夜事件-${Date.now()}`, url: 'https://1.1.1.1/midnight.ics' },
  })
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:midnight-timed-event',
    'DTSTART:20260901T000000Z',
    'DTEND:20260901T010000Z',
    'SUMMARY:午夜普通事件',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(ics, {
    status: 200,
    headers: { 'content-type': 'text/calendar' },
  })) as typeof fetch
  try {
    const response = await app.inject({ method: 'POST', url: `/api/calendars/subscriptions/${sub.id}/sync` })
    assert.equal(response.statusCode, 200)
    const event = await prisma.calendarEvent.findUniqueOrThrow({
      where: { subscriptionId_uid: { subscriptionId: sub.id, uid: 'midnight-timed-event' } },
    })
    assert.equal(event.allday, false)
  } finally {
    globalThis.fetch = originalFetch
    await prisma.calendarSubscription.delete({ where: { id: sub.id } }).catch(() => {})
  }
})
