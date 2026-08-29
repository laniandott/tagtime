import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'
import ical from 'node-ical'
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'

const MAX_ICS_BYTES = 5 * 1024 * 1024
const AUTO_SYNC_INTERVAL_MS = 60 * 60 * 1000
const syncingSubscriptions = new Set<string>()

// 从 ICS 事件中提取日期
function parseIcsDate(val: any): Date | null {
  if (!val) return null
  if (val instanceof Date) return Number.isFinite(val.getTime()) ? val : null
  if (typeof val === 'string') {
    const date = new Date(val)
    return Number.isFinite(date.getTime()) ? date : null
  }
  // ical.Date 对象
  if (typeof val === 'object' && typeof val.toDate === 'function') {
    const date = val.toDate()
    return date instanceof Date && Number.isFinite(date.getTime()) ? date : null
  }
  return null
}

// 判断是否为全天事件
function isAllDayEvent(event: any): boolean {
  const start = event.start
  if (!start) return false
  // node-ical preserves VALUE=DATE as dateOnly. Do not infer this from UTC
  // midnight because the result depends on the server timezone.
  if (start.dateOnly === true) return true
  if (start instanceof Date) {
    return start.getHours() === 0 && start.getMinutes() === 0 && start.getSeconds() === 0
  }
  return false
}

function normalizeIcsUrl(value: string): string {
  const url = new URL(value.trim())
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('ICS URL 仅支持 http 或 https')
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const blockedNames = hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')
  const ipVersion = isIP(hostname)
  const blockedIpv4 = ipVersion === 4 && (
    hostname.startsWith('10.') ||
    hostname.startsWith('192.168.') ||
    hostname.startsWith('127.') ||
    hostname.startsWith('169.254.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
  )
  const blockedIpv6 = ipVersion === 6 && (
    hostname === '::1' || hostname === '::' || hostname.startsWith('fc') ||
    hostname.startsWith('fd') || hostname.startsWith('fe80:')
  )
  if (blockedNames || blockedIpv4 || blockedIpv6) {
    throw new Error('为避免服务器端请求伪造，不允许订阅本机或内网地址')
  }
  return url.toString()
}

function stableUid(event: any, dtstart: Date, dtend: Date | null): string {
  if (event.uid) return String(event.uid)
  const source = [event.summary || '', dtstart.toISOString(), dtend?.toISOString() || '', event.location || ''].join('|')
  return `generated-${createHash('sha256').update(source).digest('hex').slice(0, 32)}`
}

// 抓取并解析 ICS 内容
async function fetchAndParseIcs(url: string): Promise<any[]> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'TagTime/1.0 CalendarSubscription' },
    signal: AbortSignal.timeout(30000),
    redirect: 'error',
  })
  if (!response.ok) {
    throw new Error(`获取 ICS 失败: ${response.status} ${response.statusText}`)
  }
  const contentLength = response.headers.get('content-length')
  if (contentLength && Number(contentLength) > MAX_ICS_BYTES) {
    throw new Error(`ICS 文件超过 ${MAX_ICS_BYTES / 1024 / 1024}MB 限制`)
  }
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_ICS_BYTES) {
    throw new Error(`ICS 文件超过 ${MAX_ICS_BYTES / 1024 / 1024}MB 限制`)
  }
  // 使用异步解析，避免大文件阻塞事件循环
  const data = await new Promise<Record<string, any>>((resolve, reject) => {
    ical.async.parseICS(text, (err: any, result: any) => {
      if (err) reject(err)
      else resolve(result)
    })
  })
  const events: any[] = []
  for (const [, event] of Object.entries(data)) {
    if (event.type === 'VEVENT') {
      events.push(event)
    }
  }
  return events
}

// 将 ICS 事件同步到数据库
async function syncSubscription(subId: string, url: string): Promise<number> {
  const events = await fetchAndParseIcs(normalizeIcsUrl(url))
  const normalized = events.flatMap((event) => {
    const summary = event.summary || '(无标题)'
    const description = event.description || null
    const location = event.location || null
    const dtstart = parseIcsDate(event.start)
    const dtend = parseIcsDate(event.end)
    const allday = isAllDayEvent(event)
    const rrule = event.rrule?.toString() || null

    if (!dtstart) return []
    return [{ uid: stableUid(event, dtstart, dtend), summary, description, location, dtstart, dtend, allday, rrule }]
  })

  const currentUids = [...new Set(normalized.map((event) => event.uid))]
  await prisma.$transaction(async (tx) => {
    for (const event of normalized) {
      await tx.calendarEvent.upsert({
        where: { subscriptionId_uid: { subscriptionId: subId, uid: event.uid } },
        create: { subscriptionId: subId, ...event },
        update: {
          summary: event.summary,
          description: event.description,
          location: event.location,
          dtstart: event.dtstart,
          dtend: event.dtend,
          allday: event.allday,
          rrule: event.rrule,
        },
      })
    }

    // 空的有效 ICS 也要清理旧缓存；否则已删除的节假日会永久残留。
    await tx.calendarEvent.deleteMany({
      where: currentUids.length > 0
        ? { subscriptionId: subId, uid: { notIn: currentUids } }
        : { subscriptionId: subId },
    })

    await tx.calendarSubscription.update({
      where: { id: subId },
      data: { lastSyncAt: new Date() },
    })
  })

  return normalized.length
}

async function runSubscriptionSync(subId: string, url: string): Promise<number> {
  if (syncingSubscriptions.has(subId)) throw new Error('该订阅正在同步，请稍后再试')
  syncingSubscriptions.add(subId)
  try {
    return await syncSubscription(subId, url)
  } finally {
    syncingSubscriptions.delete(subId)
  }
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

    let normalizedUrl: string
    try { normalizedUrl = normalizeIcsUrl(url) } catch (err) {
      reply.code(400)
      return { error: err instanceof Error ? err.message : '无效的 URL 格式' }
    }

    const sub = await prisma.calendarSubscription.create({
      data: { name: name.trim(), url: normalizedUrl, color: color || '#e74c3c' },
    })

    // 尝试首次同步（异步，不阻塞响应）
    runSubscriptionSync(sub.id, sub.url).catch((err) => {
      app.log.error(`首次同步失败 [${sub.name}]: ${err.message}`)
    })

    return sub
  })

  // 编辑订阅
  app.put('/subscriptions/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { name, url, color, active } = req.body as { name?: string; url?: string; color?: string; active?: boolean }
    if (name !== undefined && !name.trim()) {
      reply.code(400)
      return { error: '名称不能为空' }
    }

    let normalizedUrl: string | undefined
    if (url !== undefined) {
      try { normalizedUrl = normalizeIcsUrl(url) } catch (err) {
        reply.code(400)
        return { error: err instanceof Error ? err.message : '无效的 URL 格式' }
      }
    }

    try {
      return await prisma.calendarSubscription.update({
        where: { id },
        data: {
          ...(name !== undefined ? { name: name.trim() } : {}),
          ...(normalizedUrl !== undefined ? { url: normalizedUrl } : {}),
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
  app.delete('/subscriptions/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    try {
      await prisma.calendarSubscription.delete({ where: { id } })
      return { ok: true }
    } catch {
      reply.code(404)
      return { error: '订阅不存在' }
    }
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
      const count = await runSubscriptionSync(id, sub.url)
      const updated = await prisma.calendarSubscription.findUnique({ where: { id }, select: { lastSyncAt: true } })
      return { ok: true, count, lastSyncAt: updated?.lastSyncAt ?? new Date() }
    } catch (err: any) {
      reply.code(500)
      return { error: `同步失败: ${err.message}` }
    }
  })

  // ===== 外部事件查询 =====

  // 获取外部日历事件（支持时间范围筛选）
  app.get('/external-events', async (req, reply) => {
    const { from, to } = req.query as { from?: string; to?: string }

    const fromDate = from ? new Date(from) : undefined
    const toDate = to ? new Date(to) : undefined
    if ((fromDate && !Number.isFinite(fromDate.getTime())) || (toDate && !Number.isFinite(toDate.getTime()))) {
      reply.code(400)
      return { error: '无效的时间范围' }
    }

    // 读取时触发过期订阅的后台刷新，首次响应仍返回当前缓存，避免阻塞日历页面。
    const subscriptions = await prisma.calendarSubscription.findMany({
      where: { active: true },
      select: { id: true, url: true, lastSyncAt: true, name: true },
    })
    for (const sub of subscriptions) {
      const expired = !sub.lastSyncAt || Date.now() - sub.lastSyncAt.getTime() >= AUTO_SYNC_INTERVAL_MS
      if (!expired || syncingSubscriptions.has(sub.id)) continue
      runSubscriptionSync(sub.id, sub.url)
        .catch((err) => req.log.error(`后台同步失败 [${sub.name}]: ${err.message}`))
    }

    const where: Record<string, unknown> = {
      subscription: { active: true },
    }

    if (from || to) {
      const and: Record<string, unknown>[] = []
      if (fromDate) and.push({ OR: [{ dtend: { gte: fromDate } }, { dtend: null }] })
      if (toDate) and.push({ dtstart: { lte: toDate } })
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
