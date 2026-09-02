import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'

const GOAL_TYPES = new Set(['time', 'count'])
const GOAL_PERIODS = new Set(['daily', 'weekly', 'monthly', 'custom'])
const MAX_GOAL_TARGET = 2_000_000_000
const MAX_PERIOD_DAYS = 3660
const MAX_GOAL_TITLE_LENGTH = 200

function positiveInteger(value: unknown, field: string, max: number): number | null {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) return null
  return value as number
}

function overlapDurationMs(start: Date, end: Date | null, rangeStart: Date, rangeEnd: Date): number {
  const overlapStart = Math.max(start.getTime(), rangeStart.getTime())
  const overlapEnd = Math.min((end ?? new Date()).getTime(), rangeEnd.getTime())
  return Math.max(0, overlapEnd - overlapStart)
}

// 根据周期计算当前周期的起始时间
function periodStart(period: string, periodDays?: number | null): Date {
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  switch (period) {
    case 'daily':
      return todayStart
    case 'weekly': {
      const dayOfWeek = now.getDay() || 7 // 周日=7
      const start = new Date(todayStart)
      start.setDate(start.getDate() - (dayOfWeek - 1))
      return start
    }
    case 'monthly':
      return new Date(now.getFullYear(), now.getMonth(), 1)
    case 'custom': {
      const days = positiveInteger(periodDays ?? 7, 'periodDays', MAX_PERIOD_DAYS) ?? 7
      const start = new Date(todayStart)
      start.setDate(start.getDate() - (days - 1))
      return start
    }
    default:
      return todayStart
  }
}

export default async function goalRoutes(app: FastifyInstance) {
  // 列出所有目标（含关联标签和进度）
  app.get('/', async () => {
    const goals = await prisma.goal.findMany({
      where: { active: true },
      include: { tag: { include: { category: true } } },
      orderBy: { createdAt: 'desc' },
    })
    if (goals.length === 0) return []

    // 单次查询所有相关标签的记录（从最早的周期起点开始），再在内存中按目标分组，避免 N+1
    const now = new Date()
    const earliest = goals
      .map((g) => periodStart(g.period, g.periodDays))
      .reduce((min, s) => (s < min ? s : min))
    const tagIds = [...new Set(goals.map((g) => g.tagId))]
    const allEntries = await prisma.timeEntry.findMany({
      where: {
        tagId: { in: tagIds },
        startTime: { lte: now },
        OR: [{ endTime: { gte: earliest } }, { endTime: null }],
      },
      select: { tagId: true, startTime: true, endTime: true },
    })

    const result = goals.map((goal) => {
      const start = periodStart(goal.period, goal.periodDays)
      const entries = allEntries.filter((e) => e.tagId === goal.tagId)

      let current: number
      if (goal.type === 'count') {
        // 次数型按记录开始时间归属周期；跨周期的长记录不重复计数。
        current = entries.filter((e) => e.startTime >= start && e.startTime <= now).length
      } else {
        // 时长型按与周期的交集计时，避免跨周期记录被漏算或重复计算。
        const totalMs = entries.reduce((s, e) => s + overlapDurationMs(e.startTime, e.endTime, start, now), 0)
        current = Math.floor(totalMs / 60000)
      }

      return {
        ...goal,
        current,
        periodStart: start.toISOString(),
        percent: goal.target > 0 ? Math.min(100, Math.round((current / goal.target) * 100)) : 0,
      }
    })
    return result
  })

  // 创建目标
  app.post('/', async (req, reply) => {
    const { tagId, title, type, target, period, periodDays } = (req.body ?? {}) as {
      tagId: string
      title: string
      type?: string
      target?: number
      period?: string
      periodDays?: number
    }
    if (typeof tagId !== 'string' || !tagId.trim() || typeof title !== 'string' || !title.trim()) {
      reply.code(400)
      return { error: 'tagId 和 title 为必填' }
    }
    if (title.length > MAX_GOAL_TITLE_LENGTH) {
      return reply.code(400).send({ error: `title 不能超过 ${MAX_GOAL_TITLE_LENGTH} 个字符` })
    }
    const goalType = type ?? 'count'
    const goalPeriod = period ?? 'daily'
    const goalTarget = target ?? 1
    if (!GOAL_TYPES.has(goalType)) return reply.code(400).send({ error: 'type 只能是 time 或 count' })
    if (!GOAL_PERIODS.has(goalPeriod)) return reply.code(400).send({ error: 'period 无效' })
    if (positiveInteger(goalTarget, 'target', MAX_GOAL_TARGET) === null) {
      return reply.code(400).send({ error: `target 必须是 1 到 ${MAX_GOAL_TARGET} 的整数` })
    }
    const customDays = goalPeriod === 'custom' ? (periodDays ?? 7) : null
    if (customDays !== null && positiveInteger(customDays, 'periodDays', MAX_PERIOD_DAYS) === null) {
      return reply.code(400).send({ error: `periodDays 必须是 1 到 ${MAX_PERIOD_DAYS} 的整数` })
    }
    const tag = await prisma.tag.findUnique({ where: { id: tagId }, select: { id: true } })
    if (!tag) return reply.code(404).send({ error: '标签不存在' })
    return prisma.goal.create({
      data: {
        tagId,
        title: title.trim(),
        type: goalType,
        target: goalTarget,
        period: goalPeriod,
        periodDays: customDays,
      },
      include: { tag: true },
    })
  })

  // 更新目标
  app.put('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { title, type, target, period, periodDays, active } = (req.body ?? {}) as {
      title?: string
      type?: string
      target?: number
      period?: string
      periodDays?: number | null
      active?: boolean
    }
    if (title !== undefined && (typeof title !== 'string' || !title.trim())) {
      return reply.code(400).send({ error: 'title 不能为空' })
    }
    if (title !== undefined && title.length > MAX_GOAL_TITLE_LENGTH) {
      return reply.code(400).send({ error: `title 不能超过 ${MAX_GOAL_TITLE_LENGTH} 个字符` })
    }
    if (type !== undefined && !GOAL_TYPES.has(type)) {
      return reply.code(400).send({ error: 'type 只能是 time 或 count' })
    }
    if (period !== undefined && !GOAL_PERIODS.has(period)) {
      return reply.code(400).send({ error: 'period 无效' })
    }
    if (target !== undefined && positiveInteger(target, 'target', MAX_GOAL_TARGET) === null) {
      return reply.code(400).send({ error: `target 必须是 1 到 ${MAX_GOAL_TARGET} 的整数` })
    }
    if (periodDays !== undefined && periodDays !== null && positiveInteger(periodDays, 'periodDays', MAX_PERIOD_DAYS) === null) {
      return reply.code(400).send({ error: `periodDays 必须是 1 到 ${MAX_PERIOD_DAYS} 的整数` })
    }
    if (active !== undefined && typeof active !== 'boolean') {
      return reply.code(400).send({ error: 'active 必须是布尔值' })
    }

    const existing = await prisma.goal.findUnique({ where: { id } })
    if (!existing) return reply.code(404).send({ error: '目标不存在' })

    const nextPeriod = period ?? existing.period
    const data: Record<string, unknown> = {
      ...(title !== undefined ? { title: title.trim() } : {}),
      ...(type !== undefined ? { type } : {}),
      ...(target !== undefined ? { target } : {}),
      ...(period !== undefined ? { period } : {}),
      ...(active !== undefined ? { active } : {}),
    }
    // 只有明确涉及周期字段时才更新 periodDays，避免“改标题”意外清空自定义周期。
    if (period !== undefined || periodDays !== undefined) {
      data.periodDays = nextPeriod === 'custom'
        ? (periodDays ?? (existing.period === 'custom' ? existing.periodDays ?? 7 : 7))
        : null
    }

    return prisma.goal.update({
      where: { id },
      data,
      include: { tag: true },
    })
  })

  // 删除目标
  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    try {
      await prisma.goal.delete({ where: { id } })
    } catch {
      return reply.code(404).send({ error: '目标不存在' })
    }
    return { ok: true }
  })
}
