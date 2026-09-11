import type { FastifyInstance } from 'fastify'
import type { Prisma } from '@prisma/client'
import prisma from '../db.js'
import { activityDueDate, isValidClock, isValidDeadlineDay } from '../activity-rules.js'

const GOAL_KINDS = new Set(['tracking', 'activity'])
const GOAL_TYPES = new Set(['time', 'count'])
const GOAL_PERIODS = new Set(['once', 'daily', 'weekly', 'monthly', 'custom'])
const ACTIVITY_PERIODS = new Set(['once', 'daily', 'monthly'])
const MAX_GOAL_TARGET = 2_000_000_000
const MAX_PERIOD_DAYS = 3660
const MAX_GOAL_TITLE_LENGTH = 200

function positiveInteger(value: unknown, max: number): number | null {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) return null
  return value as number
}

function overlapDurationMs(start: Date, end: Date | null, rangeStart: Date, rangeEnd: Date): number {
  const overlapStart = Math.max(start.getTime(), rangeStart.getTime())
  const overlapEnd = Math.min((end ?? new Date()).getTime(), rangeEnd.getTime())
  return Math.max(0, overlapEnd - overlapStart)
}

function periodStart(period: string, periodDays?: number | null): Date {
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  switch (period) {
    case 'daily':
      return todayStart
    case 'weekly': {
      const dayOfWeek = now.getDay() || 7
      const start = new Date(todayStart)
      start.setDate(start.getDate() - (dayOfWeek - 1))
      return start
    }
    case 'monthly':
      return new Date(now.getFullYear(), now.getMonth(), 1)
    case 'custom': {
      const days = positiveInteger(periodDays ?? 7, MAX_PERIOD_DAYS) ?? 7
      const start = new Date(todayStart)
      start.setDate(start.getDate() - (days - 1))
      return start
    }
    default:
      return todayStart
  }
}

function activityDeadline(
  kind: string,
  period: string,
  deadlineTime: unknown,
  deadlineDay: unknown,
  deadlineAt: unknown,
  parentId: string | null,
): { deadlineTime: string | null; deadlineDay: number | null; deadlineAt: Date | null; error?: string } {
  if (kind !== 'activity') return { deadlineTime: null, deadlineDay: null, deadlineAt: null }
  if (!parentId) return { deadlineTime: null, deadlineDay: null, deadlineAt: null, error: '活动目标必须挂在二级标签下' }
  if (!ACTIVITY_PERIODS.has(period)) return { deadlineTime: null, deadlineDay: null, deadlineAt: null, error: '活动目标只支持一次性、每日或每月周期' }

  if (period === 'once') {
    if (typeof deadlineAt !== 'string' || !deadlineAt.trim()) {
      return { deadlineTime: null, deadlineDay: null, deadlineAt: null, error: '一次性活动必须设置截止日期和时间' }
    }
    const date = new Date(deadlineAt)
    if (!Number.isFinite(date.getTime())) {
      return { deadlineTime: null, deadlineDay: null, deadlineAt: null, error: '一次性活动的截止日期和时间无效' }
    }
    return { deadlineTime: null, deadlineDay: null, deadlineAt: date }
  }

  const normalizedTime = deadlineTime === undefined || deadlineTime === null || deadlineTime === ''
    ? period === 'monthly' ? '23:59' : null
    : deadlineTime
  if (normalizedTime === null || !isValidClock(normalizedTime)) {
    return { deadlineTime: null, deadlineDay: null, deadlineAt: null, error: '每日活动必须设置有效的截止时间（HH:mm）' }
  }
  if (period === 'monthly' && !isValidDeadlineDay(deadlineDay)) {
    return { deadlineTime: null, deadlineDay: null, deadlineAt: null, error: '每月活动必须设置 1 到 31 的截止日' }
  }
  return {
    deadlineTime: normalizedTime,
    deadlineDay: period === 'monthly' ? deadlineDay as number : null,
    deadlineAt: null,
  }
}

type ActivityGoal = {
  id: string
  title: string
  tagId: string
  period: string
  deadlineTime: string | null
  deadlineDay: number | null
  deadlineAt: Date | null
}

async function syncActivityTodo(tx: Prisma.TransactionClient, goal: ActivityGoal, categoryId: string | null) {
  const dueDate = activityDueDate(goal)
  if (!dueDate) return
  const data = {
    title: goal.title,
    priority: 0,
    dueDate,
    categoryId,
    tagId: goal.tagId,
    goalId: goal.id,
    repeatType: goal.period === 'once' ? 'none' : goal.period,
  }
  const updated = await tx.todo.updateMany({ where: { goalId: goal.id, status: 'pending' }, data })
  if (updated.count === 0) await tx.todo.create({ data })
}

export default async function goalRoutes(app: FastifyInstance) {
  app.get('/', async () => {
    const goals = await prisma.goal.findMany({
      where: { active: true },
      include: { tag: { include: { category: true } } },
      orderBy: { createdAt: 'desc' },
    })
    if (goals.length === 0) return []

    const now = new Date()
    const earliest = goals
      .map((g) => periodStart(g.period, g.periodDays))
      .reduce((min, s) => (s < min ? s : min))
    const tagIds = [...new Set(goals.map((g) => g.tagId))]
    const allEntries = await prisma.timeEntry.findMany({
      where: {
        tagId: { in: tagIds },
        dismissed: false,
        startTime: { lte: now },
        OR: [{ endTime: { gte: earliest } }, { endTime: null }],
      },
      select: { tagId: true, startTime: true, endTime: true },
    })
    const activityGoalIds = goals.filter((goal) => goal.kind === 'activity').map((goal) => goal.id)
    const completedActivities = activityGoalIds.length === 0
      ? []
      : await prisma.todo.findMany({
        where: { goalId: { in: activityGoalIds }, status: 'done', completedAt: { not: null } },
        select: { goalId: true, completedAt: true },
      })

    return goals.map((goal) => {
      const start = periodStart(goal.period, goal.periodDays)
      const entries = allEntries.filter((e) => e.tagId === goal.tagId)
      let current: number
      if (goal.kind === 'activity') {
        current = completedActivities.filter((todo) => (
          todo.goalId === goal.id && todo.completedAt && (goal.period === 'once' || todo.completedAt >= start) && todo.completedAt <= now
        )).length
      } else if (goal.type === 'count') {
        current = entries.filter((e) => e.startTime >= start && e.startTime <= now).length
      } else {
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
  })

  app.post('/', async (req, reply) => {
    const { tagId, title, kind, type, target, period, periodDays, deadlineTime, deadlineDay, deadlineAt } = (req.body ?? {}) as {
      tagId: string
      title: string
      kind?: string
      type?: string
      target?: number
      period?: string
      periodDays?: number
      deadlineTime?: string | null
      deadlineDay?: number | null
      deadlineAt?: string | null
    }
    if (typeof tagId !== 'string' || !tagId.trim() || typeof title !== 'string' || !title.trim()) {
      return reply.code(400).send({ error: 'tagId 和 title 为必填' })
    }
    if (title.length > MAX_GOAL_TITLE_LENGTH) return reply.code(400).send({ error: `title 不能超过 ${MAX_GOAL_TITLE_LENGTH} 个字符` })

    const goalKind = kind ?? 'tracking'
    const goalPeriod = period ?? 'daily'
    const goalType = goalKind === 'activity' ? 'count' : (type ?? 'count')
    const goalTarget = goalKind === 'activity' ? 1 : (target ?? 1)
    if (!GOAL_KINDS.has(goalKind)) return reply.code(400).send({ error: 'kind 只能是 tracking 或 activity' })
    if (!GOAL_TYPES.has(goalType)) return reply.code(400).send({ error: 'type 只能是 time 或 count' })
    if (!GOAL_PERIODS.has(goalPeriod)) return reply.code(400).send({ error: 'period 无效' })
    if (positiveInteger(goalTarget, MAX_GOAL_TARGET) === null) return reply.code(400).send({ error: `target 必须是 1 到 ${MAX_GOAL_TARGET} 的整数` })

    const customDays = goalPeriod === 'custom' ? (periodDays ?? 7) : null
    if (customDays !== null && positiveInteger(customDays, MAX_PERIOD_DAYS) === null) {
      return reply.code(400).send({ error: `periodDays 必须是 1 到 ${MAX_PERIOD_DAYS} 的整数` })
    }
    const tag = await prisma.tag.findUnique({ where: { id: tagId }, select: { id: true, categoryId: true, parentId: true } })
    if (!tag) return reply.code(404).send({ error: '标签不存在' })
    const deadline = activityDeadline(goalKind, goalPeriod, deadlineTime, deadlineDay, deadlineAt, tag.parentId)
    if (deadline.error) return reply.code(400).send({ error: deadline.error })

    const created = await prisma.$transaction(async (tx) => {
      const goal = await tx.goal.create({
        data: {
          tagId,
          title: title.trim(),
          kind: goalKind,
          type: goalType,
          target: goalTarget,
          period: goalPeriod,
          periodDays: goalKind === 'tracking' ? customDays : null,
          deadlineTime: deadline.deadlineTime,
          deadlineDay: deadline.deadlineDay,
          deadlineAt: deadline.deadlineAt,
        },
      })
      if (goalKind === 'activity') await syncActivityTodo(tx, goal, tag.categoryId)
      return goal
    })
    return prisma.goal.findUnique({ where: { id: created.id }, include: { tag: true } })
  })

  app.put('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { title, kind, type, target, period, periodDays, deadlineTime, deadlineDay, deadlineAt, active } = (req.body ?? {}) as {
      title?: string
      kind?: string
      type?: string
      target?: number
      period?: string
      periodDays?: number | null
      deadlineTime?: string | null
      deadlineDay?: number | null
      deadlineAt?: string | null
      active?: boolean
    }
    const existing = await prisma.goal.findUnique({ where: { id }, include: { tag: { select: { categoryId: true, parentId: true } } } })
    if (!existing) return reply.code(404).send({ error: '目标不存在' })
    if (title !== undefined && (typeof title !== 'string' || !title.trim())) return reply.code(400).send({ error: 'title 不能为空' })
    if (title !== undefined && title.length > MAX_GOAL_TITLE_LENGTH) return reply.code(400).send({ error: `title 不能超过 ${MAX_GOAL_TITLE_LENGTH} 个字符` })
    if (kind !== undefined && !GOAL_KINDS.has(kind)) return reply.code(400).send({ error: 'kind 只能是 tracking 或 activity' })
    if (type !== undefined && !GOAL_TYPES.has(type)) return reply.code(400).send({ error: 'type 只能是 time 或 count' })
    if (period !== undefined && !GOAL_PERIODS.has(period)) return reply.code(400).send({ error: 'period 无效' })
    if (target !== undefined && positiveInteger(target, MAX_GOAL_TARGET) === null) return reply.code(400).send({ error: `target 必须是 1 到 ${MAX_GOAL_TARGET} 的整数` })
    if (periodDays !== undefined && periodDays !== null && positiveInteger(periodDays, MAX_PERIOD_DAYS) === null) return reply.code(400).send({ error: `periodDays 必须是 1 到 ${MAX_PERIOD_DAYS} 的整数` })
    if (active !== undefined && typeof active !== 'boolean') return reply.code(400).send({ error: 'active 必须是布尔值' })

    const nextKind = kind ?? existing.kind
    const nextPeriod = period ?? existing.period
    const nextDeadlineTime = deadlineTime !== undefined ? deadlineTime : existing.deadlineTime
    const nextDeadlineDay = deadlineDay !== undefined ? deadlineDay : existing.deadlineDay
    const nextDeadlineAt = deadlineAt !== undefined ? deadlineAt : existing.deadlineAt?.toISOString() ?? null
    const deadline = activityDeadline(nextKind, nextPeriod, nextDeadlineTime, nextDeadlineDay, nextDeadlineAt, existing.tag.parentId)
    if (deadline.error) return reply.code(400).send({ error: deadline.error })

    const data: Record<string, unknown> = {
      ...(title !== undefined ? { title: title.trim() } : {}),
      kind: nextKind,
      type: nextKind === 'activity' ? 'count' : (type ?? existing.type),
      target: nextKind === 'activity' ? 1 : (target ?? existing.target),
      ...(period !== undefined ? { period } : {}),
      deadlineTime: deadline.deadlineTime,
      deadlineDay: deadline.deadlineDay,
      deadlineAt: deadline.deadlineAt,
      ...(active !== undefined ? { active } : {}),
    }
    if (nextKind === 'tracking' && (period !== undefined || periodDays !== undefined)) {
      data.periodDays = nextPeriod === 'custom'
        ? (periodDays ?? (existing.period === 'custom' ? existing.periodDays ?? 7 : 7))
        : null
    } else if (nextKind === 'activity') {
      data.periodDays = null
    }

    const updated = await prisma.$transaction(async (tx) => {
      const goal = await tx.goal.update({ where: { id }, data })
      if (goal.kind === 'activity' && goal.active) {
        await syncActivityTodo(tx, goal, existing.tag.categoryId)
      } else {
        await tx.todo.deleteMany({ where: { goalId: id, status: 'pending' } })
      }
      return goal
    })
    return prisma.goal.findUnique({ where: { id: updated.id }, include: { tag: true } })
  })

  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    try {
      await prisma.$transaction(async (tx) => {
        await tx.todo.deleteMany({ where: { goalId: id, status: 'pending' } })
        await tx.goal.delete({ where: { id } })
      })
    } catch {
      return reply.code(404).send({ error: '目标不存在' })
    }
    return { ok: true }
  })
}
