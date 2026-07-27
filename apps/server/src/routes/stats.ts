import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'

// 计算时长（毫秒），endTime 为空则用当前时间
function durationMs(start: Date, end: Date | null): number {
  return (end ?? new Date()).getTime() - start.getTime()
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

export default async function statsRoutes(app: FastifyInstance) {
  // 概览：今日/本周/本月总时长 + 今日按分类分布
  app.get('/summary', async (req) => {
    const { categoryId } = req.query as { categoryId?: string }
    const cf = categoryFilter(categoryId)
    const now = new Date()
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const dayOfWeek = now.getDay() || 7 // 周日=7
    const weekStart = new Date(todayStart)
    weekStart.setDate(weekStart.getDate() - (dayOfWeek - 1))
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

    const [todayEntries, weekEntries, monthEntries] = await Promise.all([
      prisma.timeEntry.findMany({
        where: { startTime: { gte: todayStart }, ...cf },
        include: { tag: { include: { category: true } } },
      }),
      prisma.timeEntry.findMany({
        where: { startTime: { gte: weekStart }, ...cf },
      }),
      prisma.timeEntry.findMany({
        where: { startTime: { gte: monthStart }, ...cf },
      }),
    ])

    const todayMs = todayEntries.reduce((s: number, e: { startTime: Date; endTime: Date | null }) => s + durationMs(e.startTime, e.endTime), 0)
    const weekMs = weekEntries.reduce((s: number, e: { startTime: Date; endTime: Date | null }) => s + durationMs(e.startTime, e.endTime), 0)
    const monthMs = monthEntries.reduce((s: number, e: { startTime: Date; endTime: Date | null }) => s + durationMs(e.startTime, e.endTime), 0)

    // 今日按分类聚合
    const byCategory = new Map<string, { name: string; color: string; ms: number }>()
    for (const e of todayEntries) {
      const cat = e.tag.category
      const key = cat?.id ?? 'uncategorized'
      const name = cat?.name ?? '未分类'
      const color = cat?.color ?? '#9ca3af'
      const cur = byCategory.get(key) ?? { name, color, ms: 0 }
      cur.ms += durationMs(e.startTime, e.endTime)
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
  app.get('/daily', async (req) => {
    const { days: daysStr, categoryId, from, to } = req.query as {
      days?: string
      categoryId?: string
      from?: string
      to?: string
    }
    const cf = categoryFilter(categoryId)
    const now = new Date()
    let start: Date
    let end: Date
    let totalDays: number

    if (from) {
      // 自定义日期范围
      start = new Date(from)
      start.setHours(0, 0, 0, 0)
      end = to ? new Date(to) : new Date(now)
      end.setHours(23, 59, 59, 999)
      // 计算天数（含首尾）
      totalDays = Math.ceil((end.getTime() - start.getTime()) / (24 * 3600 * 1000)) + 1
    } else {
      // 默认：最近 N 天
      totalDays = Number(daysStr ?? 7)
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      start.setDate(start.getDate() - (totalDays - 1))
      end = now
    }

    const entries = await prisma.timeEntry.findMany({
      where: { startTime: { gte: start, lte: end }, ...cf },
      include: { tag: { include: { category: true } } },
    })

    const buckets = new Map<string, { date: string; total: number; byCategory: Map<string, { name: string; color: string; ms: number }> }>()
    for (let i = 0; i < totalDays; i++) {
      const d = new Date(start)
      d.setDate(d.getDate() + i)
      buckets.set(dayKey(d), { date: dayKey(d), total: 0, byCategory: new Map() })
    }

    for (const e of entries) {
      const key = dayKey(e.startTime)
      const bucket = buckets.get(key)
      if (!bucket) continue
      const ms = durationMs(e.startTime, e.endTime)
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

    return Array.from(buckets.values()).map((b) => ({
      date: b.date,
      total: b.total,
      byCategory: Array.from(b.byCategory.values()).sort((x, y) => y.ms - x.ms),
    }))
  })

  // 按标签聚合（指定日期范围）
  app.get('/by-tag', async (req) => {
    const { from, to, categoryId } = req.query as { from?: string; to?: string; categoryId?: string }
    const cf = categoryFilter(categoryId)
    const end = to ? new Date(to) : new Date()
    let start: Date
    if (from) {
      start = new Date(from)
    } else {
      start = new Date(end.getFullYear(), end.getMonth(), end.getDate())
      start.setDate(start.getDate() - 6) // 未指定 from 时默认最近7天
    }

    const entries = await prisma.timeEntry.findMany({
      where: { startTime: { gte: start, lte: end }, ...cf },
      include: { tag: { include: { category: true } } },
    })

    const map = new Map<string, { tagId: string; tagName: string; color: string; category: string | null; ms: number }>()
    for (const e of entries) {
      const cur = map.get(e.tagId) ?? {
        tagId: e.tagId,
        tagName: e.tag.name,
        color: e.tag.color,
        category: e.tag.category?.name ?? null,
        ms: 0,
      }
      cur.ms += durationMs(e.startTime, e.endTime)
      map.set(e.tagId, cur)
    }
    return Array.from(map.values()).sort((a, b) => b.ms - a.ms)
  })
}
