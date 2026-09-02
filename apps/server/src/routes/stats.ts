import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'
import { singleQueryString } from './query.js'

// 计算记录与查询区间的交集，运行中的记录最多计到 rangeEnd。
export function overlapDurationMs(start: Date, end: Date | null, rangeStart: Date, rangeEnd: Date): number {
  const overlapStart = Math.max(start.getTime(), rangeStart.getTime())
  const overlapEnd = Math.min((end ?? new Date()).getTime(), rangeEnd.getTime())
  return Math.max(0, overlapEnd - overlapStart)
}

// 日期 key: YYYY-MM-DD（本地时区）
function dayKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// 构建分类筛选条件
function categoryFilter(categoryId?: string) {
  if (!categoryId) return {}
  if (categoryId === 'none') return { tag: { categoryId: null } }
  return { tag: { categoryId } }
}

function overlappingRange(start: Date, end: Date) {
  return {
    startTime: { lte: end },
    OR: [{ endTime: { gte: start } }, { endTime: null }],
  }
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

function calendarDayCount(start: Date, end: Date): number {
  const startUtc = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())
  const endUtc = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate())
  return Math.round((endUtc - startUtc) / (24 * 3600 * 1000)) + 1
}

function calendarDayIndex(value: Date, rangeStart: Date): number {
  const valueUtc = Date.UTC(value.getFullYear(), value.getMonth(), value.getDate())
  const startUtc = Date.UTC(rangeStart.getFullYear(), rangeStart.getMonth(), rangeStart.getDate())
  return Math.round((valueUtc - startUtc) / (24 * 3600 * 1000))
}

export default async function statsRoutes(app: FastifyInstance) {
  // 概览：今日/本周/本月总时长 + 今日按分类分布
  app.get('/summary', async (req, reply) => {
    const categoryId = singleQueryString((req.query as Record<string, unknown>).categoryId)
    if (categoryId === null) return reply.code(400).send({ error: 'categoryId 必须是单个字符串' })
    const cf = categoryFilter(categoryId)
    const now = new Date()
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const dayOfWeek = now.getDay() || 7 // 周日=7
    const weekStart = new Date(todayStart)
    weekStart.setDate(weekStart.getDate() - (dayOfWeek - 1))
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

    const earliest = new Date(Math.min(todayStart.getTime(), weekStart.getTime(), monthStart.getTime()))
    const entries = await prisma.timeEntry.findMany({
      where: { ...overlappingRange(earliest, now), ...cf },
      include: { tag: { include: { category: true } } },
    })

    const todayMs = entries.reduce((sum, entry) => sum + overlapDurationMs(entry.startTime, entry.endTime, todayStart, now), 0)
    const weekMs = entries.reduce((sum, entry) => sum + overlapDurationMs(entry.startTime, entry.endTime, weekStart, now), 0)
    const monthMs = entries.reduce((sum, entry) => sum + overlapDurationMs(entry.startTime, entry.endTime, monthStart, now), 0)

    // 今日按分类聚合
    const byCategory = new Map<string, { name: string; color: string; ms: number }>()
    for (const e of entries) {
      const ms = overlapDurationMs(e.startTime, e.endTime, todayStart, now)
      if (ms === 0) continue
      const cat = e.tag.category
      const key = cat?.id ?? 'uncategorized'
      const name = cat?.name ?? '未分类'
      const color = cat?.color ?? '#9ca3af'
      const cur = byCategory.get(key) ?? { name, color, ms: 0 }
      cur.ms += ms
      byCategory.set(key, cur)
    }

    return {
      today: todayMs,
      week: weekMs,
      month: monthMs,
      todayByCategory: Array.from(byCategory.values()).sort((a, b) => b.ms - a.ms),
    }
  })

  // 每日趋势：支持自定义日期范围（from/to）或最近 N 天（days）
  app.get('/daily', async (req, reply) => {
    const raw = req.query as Record<string, unknown>
    const daysStr = singleQueryString(raw.days)
    const categoryId = singleQueryString(raw.categoryId)
    const from = singleQueryString(raw.from)
    const to = singleQueryString(raw.to)
    if (daysStr === null || categoryId === null || from === null || to === null) {
      return reply.code(400).send({ error: '查询参数必须是单个字符串' })
    }
    const cf = categoryFilter(categoryId)
    const now = new Date()
    let start: Date
    let end: Date
    let totalDays: number

    if (from || to) {
      // 自定义日期范围
      const parsedStart = from ? parseDate(from) : null
      const parsedEnd = to ? parseDate(to) : new Date(now)
      if ((from && !parsedStart) || !parsedEnd) return reply.code(400).send({ error: '日期范围无效' })
      start = parsedStart ?? new Date(parsedEnd as Date)
      if (!parsedStart) {
        // 仅传 to 时按“截至该日最近 7 天”处理，避免静默忽略 to 参数。
        start.setHours(0, 0, 0, 0)
        start.setDate(start.getDate() - 6)
      }
      start.setHours(0, 0, 0, 0)
      end = parsedEnd as Date
      end.setHours(23, 59, 59, 999)
      if (end < start) return reply.code(400).send({ error: '结束日期不能早于开始日期' })
      // 计算天数（含首尾）
      const endDay = new Date(end)
      endDay.setHours(0, 0, 0, 0)
      totalDays = calendarDayCount(start, endDay)
      if (totalDays > 3660) return reply.code(400).send({ error: '日期范围不能超过 3660 天' })
    } else {
      // 默认：最近 N 天
      const requestedDays = Number(daysStr ?? 7)
      if (!Number.isInteger(requestedDays) || requestedDays < 1 || requestedDays > 3660) {
        return reply.code(400).send({ error: 'days 必须是 1 到 3660 的整数' })
      }
      totalDays = requestedDays
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      start.setDate(start.getDate() - (totalDays - 1))
      end = now
    }

    const entries = await prisma.timeEntry.findMany({
      where: { ...overlappingRange(start, end), ...cf },
      include: { tag: { include: { category: true } } },
    })

    const buckets: { date: string; start: Date; end: Date; total: number; byCategory: Map<string, { name: string; color: string; ms: number }> }[] = []
    for (let i = 0; i < totalDays; i++) {
      const d = new Date(start)
      d.setDate(d.getDate() + i)
      const next = new Date(d)
      next.setDate(next.getDate() + 1)
      buckets.push({ date: dayKey(d), start: d, end: next < end ? next : end, total: 0, byCategory: new Map() })
    }

    for (const e of entries) {
      const entryEnd = e.endTime ?? end
      const firstIndex = Math.max(0, Math.min(totalDays - 1, calendarDayIndex(e.startTime, start)))
      const lastIndex = Math.max(0, Math.min(totalDays - 1, calendarDayIndex(entryEnd, start)))
      for (let i = firstIndex; i <= lastIndex; i++) {
        const bucket = buckets[i]
        const ms = overlapDurationMs(e.startTime, e.endTime, bucket.start, bucket.end)
        if (ms === 0) continue
        bucket.total += ms
        const cat = e.tag.category
        const ckey = cat?.id ?? 'uncategorized'
        const cur = bucket.byCategory.get(ckey) ?? {
          name: cat?.name ?? '未分类',
          color: cat?.color ?? '#9ca3af',
          ms: 0,
        }
        cur.ms += ms
        bucket.byCategory.set(ckey, cur)
      }
    }

    return buckets.map((b) => ({
      date: b.date,
      total: b.total,
      byCategory: Array.from(b.byCategory.values()).sort((x, y) => y.ms - x.ms),
    }))
  })

  // 按标签聚合（指定日期范围）
  app.get('/by-tag', async (req, reply) => {
    const raw = req.query as Record<string, unknown>
    const from = singleQueryString(raw.from)
    const to = singleQueryString(raw.to)
    const categoryId = singleQueryString(raw.categoryId)
    if (from === null || to === null || categoryId === null) {
      return reply.code(400).send({ error: '查询参数必须是单个字符串' })
    }
    const cf = categoryFilter(categoryId)
    const end = to ? parseDate(to) : new Date()
    if (!end) return reply.code(400).send({ error: '结束时间无效' })
    let start: Date
    if (from) {
      const parsedStart = parseDate(from)
      if (!parsedStart) return reply.code(400).send({ error: '开始时间无效' })
      start = parsedStart
    } else {
      start = new Date(end.getFullYear(), end.getMonth(), end.getDate())
      start.setDate(start.getDate() - 6) // 未指定 from 时默认最近7天
    }
    if (end < start) return reply.code(400).send({ error: '结束时间不能早于开始时间' })
    if (calendarDayCount(start, new Date(end.getFullYear(), end.getMonth(), end.getDate())) > 3660) {
      return reply.code(400).send({ error: '日期范围不能超过 3660 天' })
    }

    const entries = await prisma.timeEntry.findMany({
      where: { ...overlappingRange(start, end), ...cf },
      include: { tag: { include: { category: true } } },
    })

    const map = new Map<string, { tagId: string; tagName: string; color: string; category: string | null; ms: number }>()
    for (const e of entries) {
      const ms = overlapDurationMs(e.startTime, e.endTime, start, end)
      if (ms === 0) continue
      const cur = map.get(e.tagId) ?? {
        tagId: e.tagId,
        tagName: e.tag.name,
        color: e.tag.color,
        category: e.tag.category?.name ?? null,
        ms: 0,
      }
      cur.ms += ms
      map.set(e.tagId, cur)
    }
    return Array.from(map.values()).sort((a, b) => b.ms - a.ms)
  })
}
