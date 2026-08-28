import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'
import ical from 'node-ical'

// 从 ICS 事件中提取日期，处理全天事件的时区问题
function parseIcsDate(val: ical.Date | Date | string | undefined): Date | null {
  if (!val) return null
  if (val instanceof Date) return val
  if (typeof val === 'string') return new Date(val)
  // ical.Date 对象
  if ('getDate' in val && typeof (val as any).getDate === 'function') {
    return (val as ical.Date).toDate()
  }
  return null
}

// 判断是否为全天事件
function isAllDayEvent(event: ical.CalendarComponent): boolean {
  const start = event.start
  if (!start) return false
  // 如果开始时间是 ical.Date 类型且没有时间部分，视为全天事件
  if (start instanceof Date) {
    return start.getHours() === 0 && start.getMinutes() === 0 && start.getSeconds() === 0
  }
  return false
}

// 抓取并解析 ICS 内容
async function fetchAndParseIcs(url: string): Promise<ical.CalendarComponent[]> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'TagTime/1.0 CalendarSubscription' },
    signal: AbortSignal.timeout(15000), // 15秒超时
  })
  if (!response.ok) {
    throw new Error(`获取 ICS 失败: ${response.status} ${response.statusText}`)
  }
  const text = await response.text()
  const data = ical.sync.parseICS(text)
  const events: ical.CalendarComponent[] = []
  for (const [, event] of Object.entries(data)) {
    if (event.type === 'VEVENT') {
      events.push(event)
    }
  }
  return events
}

// 将 ICS 事件同步到数据库
async function syncSubscription(subId: string, url: string): Promise<number> {
  const events = await fetchAndParseIcs(url)
  let count = 0

  for (const event of events) {
    const uid = event.uid || `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const summary = event.summary || '(无标题)'
    const description = event.description || null
    const location = event.location || null
    const dtstart = parseIcsDate(event.start)
    const dtend = parseIcsDate(event.end)
    const allday = isAllDayEvent(event)
    const rrule = event.rrule?.toString() || null

    if (!dtstart) continue

    try {
      await prisma.calendarEvent.upsert({
        where: { subscriptionId_uid: { subscriptionId: subId, uid } },
        create: { subscriptionId: subId, uid, summary, description, location, dtstart, dtend, allday, rrule },
        update: { summary, description, location, dtstart, dtend, allday, rrule },
      })
      count++
    } catch {
      // 跳过重复或无效事件
    }
  }

  // 删除 ICS 中已不存在的事件
  const currentUids = events.map((e) => e.uid).filter(Boolean)
  if (currentUids.length > 0) {
    await prisma.calendarEvent.deleteMany({
      where: { subscriptionId: subId, uid: { notIn: currentUids } },
    })
  }

  // 更新同步时间
  await prisma.calendarSubscription.update({
    where: { id: subId },
    data: { lastSyncAt: new Date() },
  })

  return count
}

export default async function calendarsRoutes(app: FastifyInstance) {
  // ===== 订阅 CRUD =====

  // 列出所有订阅
  app.get('/subscriptions', async () => {
    return prisma.calendarSubscription.findMany({ orderBy: { createdAt: 'desc' } })
  })

  // 添加订阅
  app.post('/subscriptions', async (req, reply) => {
    const { name, url, color } = req.body as { name?: string; url?: string; color?: string }
    if (!url?.trim()) {
      reply.code(400)
      return { error: 'URL 不能为空' }
    }
    if (!name?.trim()) {
      reply.code(400)
      return { error: '名称不能为空' }
    }

    // 验证 URL 格式
    try { new URL(url.trim()) } catch {
      reply.code(400)
      return { error: '无效的 URL 格式' }
    }

    // 创建订阅
    const sub = await prisma.calendarSubscription.create({
      data: { name: name.trim(), url: url.trim(), color: color || '#e74c3c' },
    })

    // 尝试首次同步（异步，不阻塞响应）
    syncSubscription(sub.id, sub.url).catch((err) => {
      app.log.error(`首次同步失败 [${sub.name}]: ${err.message}`)
    })

    return sub
  })

  // 编辑订阅
  app.put('/subscriptions/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { name, url, color, active } = req.body as { name?: string; url?: string; color?: string; active?: boolean }
    try {
      return await prisma.calendarSubscription.update({
        where: { id },
        data: {
          ...(name !== undefined ? { name: name.trim() } : {}),
          ...(url !== undefined ? { url: url.trim() } : {}),
          ...(color !== undefined ? { color } : {}),
          ...(active !== undefined ? { active } : {}),
        },
      })
    } catch {
      reply.code(404)
      return { error: '订阅不存在' }
    }
  })

  // 删除订阅
  app.delete('/subscriptions/:id', async (req) => {
    const { id } = req.params as { id: string }
    await prisma.calendarSubscription.delete({ where: { id } })
    return { ok: true }
  })

  // 手动同步订阅
  app.post('/subscriptions/:id/sync', async (req, reply) => {
    const { id } = req.params as { id: string }
    const sub = await prisma.calendarSubscription.findUnique({ where: { id } })
    if (!sub) {
      reply.code(404)
      return { error: '订阅不存在' }
    }
    try {
      const count = await syncSubscription(id, sub.url)
      return { ok: true, count, lastSyncAt: new Date() }
    } catch (err: any) {
      reply.code(500)
      return { error: `同步失败: ${err.message}` }
    }
  })

  // ===== 外部事件查询 =====

  // 获取外部日历事件（支持时间范围筛选）
  app.get('/external-events', async (req) => {
    const { from, to } = req.query as { from?: string; to?: string }

    const where: Record<string, unknown> = {
      subscription: { active: true },
    }

    if (from || to) {
      const and: Record<string, unknown>[] = []
      if (from) and.push({ dtend: { gte: new Date(from) } })
      if (to) and.push({ dtstart: { lte: new Date(to) } })
      where.AND = and
    }

    return prisma.calendarEvent.findMany({
      where,
      include: { subscription: { select: { name: true, color: true } } },
      orderBy: { dtstart: 'asc' },
      take: 2000,
    })
  })
}
