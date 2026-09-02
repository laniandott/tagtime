import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'
import ical from 'node-ical'
import { createHash } from 'node:crypto'
import { BlockList, isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { singleQueryString } from './query.js'

const MAX_ICS_BYTES = 5 * 1024 * 1024
const AUTO_SYNC_INTERVAL_MS = 60 * 60 * 1000
const syncingSubscriptions = new Set<string>()
const MAX_SUBSCRIPTION_NAME = 200
const MAX_SUBSCRIPTION_COLOR = 32

function validSubscriptionColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{3,8}$/i.test(value)
}

const blockedNetworks = new BlockList()
for (const [network, prefix, family] of [
  ['0.0.0.0', 8, 'ipv4'], ['10.0.0.0', 8, 'ipv4'], ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'], ['169.254.0.0', 16, 'ipv4'], ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'], ['192.0.2.0', 24, 'ipv4'], ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'], ['198.51.100.0', 24, 'ipv4'], ['203.0.113.0', 24, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'], ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'], ['::1', 128, 'ipv6'], ['fc00::', 7, 'ipv6'], ['fe80::', 10, 'ipv6'],
  ['ff00::', 8, 'ipv6'], ['2001:db8::', 32, 'ipv6'],
] as const) {
  blockedNetworks.addSubnet(network, prefix, family)
}

function mappedIpv4(address: string): string | null {
  const lower = address.toLowerCase()
  if (!lower.startsWith('::ffff:')) return null
  const tail = lower.slice('::ffff:'.length)
  if (tail.includes('.')) return isIP(tail) === 4 ? tail : null
  const groups = tail.split(':')
  if (groups.length !== 2 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null
  const value = (Number.parseInt(groups[0], 16) << 16) | Number.parseInt(groups[1], 16)
  return `${(value >>> 24) & 255}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`
}

function isBlockedAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return blockedNetworks.check(address, 'ipv4')
  if (family === 6) {
    const mapped = mappedIpv4(address)
    return (mapped ? blockedNetworks.check(mapped, 'ipv4') : false) || blockedNetworks.check(address, 'ipv6')
  }
  return false
}

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
  // node-ical preserves VALUE=DATE as dateOnly (and may expose datetype on
  // the event). A timed event is allowed to start at exactly midnight, so
  // never infer “全天” from the clock components of a Date object.
  return event.datetype === 'date' || start.dateOnly === true
}

function normalizeIcsUrl(value: string): string {
  const url = new URL(value.trim())
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('ICS URL 仅支持 http 或 https')
  }
  if (url.username || url.password) {
    throw new Error('ICS URL 不允许携带用户名或密码')
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const blockedNames = hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')
  if (blockedNames || isBlockedAddress(hostname)) {
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
  const parsedUrl = new URL(url)
  const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, '')
  // 仅校验域名文本不足以防 DNS 指向内网；同步前再次解析所有地址，
  // 拒绝解析结果中的回环、私网、链路本地、保留和多播地址。
  if (isBlockedAddress(hostname)) {
    throw new Error('为避免服务器端请求伪造，不允许订阅本机或内网地址')
  }
  if (isIP(hostname) === 0) {
    let addresses
    try {
      addresses = await lookup(hostname, { all: true, verbatim: true })
    } catch {
      throw new Error('无法解析 ICS 地址')
    }
    if (!addresses.length || addresses.some((item) => isBlockedAddress(item.address))) {
      throw new Error('为避免服务器端请求伪造，不允许订阅解析到本机或内网地址')
    }
  }

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
  const reader = response.body?.getReader()
  if (!reader) throw new Error('ICS 响应为空')
  const chunks: Buffer[] = []
  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = Buffer.from(value)
      totalBytes += chunk.length
      if (totalBytes > MAX_ICS_BYTES) {
        await reader.cancel()
        throw new Error(`ICS 文件超过 ${MAX_ICS_BYTES / 1024 / 1024}MB 限制`)
      }
      chunks.push(chunk)
    }
  } finally {
    reader.releaseLock()
  }
  const text = Buffer.concat(chunks, totalBytes).toString('utf8')
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
  if (events.length > 10000) throw new Error('ICS 事件数量超过 10000 条限制')
  return events
}

// 将 ICS 事件同步到数据库
async function syncSubscription(subId: string, url: string): Promise<number> {
  const normalizedUrl = normalizeIcsUrl(url)
  const events = await fetchAndParseIcs(normalizedUrl)
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
    // 订阅地址可能在抓取期间被修改。只有 URL 仍与本次同步一致时才允许
    // 把旧源的事件写回，避免“改地址后旧请求晚到”污染新订阅缓存。
    const current = await tx.calendarSubscription.findUnique({
      where: { id: subId },
      select: { url: true },
    })
    if (!current) throw new Error('订阅不存在')
    if (current.url !== normalizedUrl) throw new Error('订阅地址已变更，请重新同步')

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
    const { name, url, color } = (req.body ?? {}) as { name?: string; url?: string; color?: string }
    if (typeof url !== 'string' || !url.trim()) {
      reply.code(400)
      return { error: 'URL 不能为空' }
    }
    if (typeof name !== 'string' || !name.trim() || name.length > MAX_SUBSCRIPTION_NAME) {
      reply.code(400)
      return { error: `名称不能为空且不能超过 ${MAX_SUBSCRIPTION_NAME} 个字符` }
    }
    if (color !== undefined && (!validSubscriptionColor(color) || color.length > MAX_SUBSCRIPTION_COLOR)) {
      return reply.code(400).send({ error: '颜色参数无效' })
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
    const { name, url, color, active } = (req.body ?? {}) as { name?: string; url?: string; color?: string; active?: boolean }
    if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > MAX_SUBSCRIPTION_NAME)) {
      reply.code(400)
      return { error: `名称不能为空且不能超过 ${MAX_SUBSCRIPTION_NAME} 个字符` }
    }
    if (url !== undefined && (typeof url !== 'string' || !url.trim())) {
      return reply.code(400).send({ error: 'URL 不能为空' })
    }
    if (color !== undefined && (!validSubscriptionColor(color) || color.length > MAX_SUBSCRIPTION_COLOR)) {
      return reply.code(400).send({ error: '颜色参数无效' })
    }
    if (active !== undefined && typeof active !== 'boolean') {
      return reply.code(400).send({ error: 'active 必须是布尔值' })
    }

    let normalizedUrl: string | undefined
    if (url !== undefined) {
      try { normalizedUrl = normalizeIcsUrl(url) } catch (err) {
        reply.code(400)
        return { error: err instanceof Error ? err.message : '无效的 URL 格式' }
      }
    }

    const existing = await prisma.calendarSubscription.findUnique({ where: { id } })
    if (!existing) return reply.code(404).send({ error: '订阅不存在' })
    const urlChanged = normalizedUrl !== undefined && normalizedUrl !== existing.url
    const reactivated = active === true && !existing.active

    try {
      return await prisma.calendarSubscription.update({
        where: { id },
        data: {
          ...(name !== undefined ? { name: name.trim() } : {}),
          ...(normalizedUrl !== undefined ? { url: normalizedUrl } : {}),
          ...(color !== undefined ? { color } : {}),
          ...(active !== undefined ? { active } : {}),
          ...(urlChanged || reactivated ? { lastSyncAt: null } : {}),
        },
      })
    } catch (error: any) {
      if (error?.code === 'P2025') return reply.code(404).send({ error: '订阅不存在' })
      throw error
    }
  })

  // 删除订阅
  app.delete('/subscriptions/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    try {
      await prisma.calendarSubscription.delete({ where: { id } })
      return { ok: true }
    } catch (error: any) {
      if (error?.code === 'P2025') return reply.code(404).send({ error: '订阅不存在' })
      throw error
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
      req.log.error(err, `日历订阅同步失败: ${id}`)
      reply.code(502)
      return { error: '同步失败，请检查订阅地址或稍后重试' }
    }
  })

  // ===== 外部事件查询 =====

  // 获取外部日历事件（支持时间范围筛选）
  app.get('/external-events', async (req, reply) => {
    const raw = req.query as Record<string, unknown>
    const from = singleQueryString(raw.from)
    const to = singleQueryString(raw.to)
    if (from === null || to === null) return reply.code(400).send({ error: '查询参数必须是单个字符串' })

    const fromDate = from ? new Date(from) : undefined
    const toDate = to ? new Date(to) : undefined
    if ((fromDate && !Number.isFinite(fromDate.getTime())) || (toDate && !Number.isFinite(toDate.getTime()))) {
      reply.code(400)
      return { error: '无效的时间范围' }
    }
    if (fromDate && toDate && toDate < fromDate) {
      reply.code(400)
      return { error: 'to 不能早于 from' }
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
