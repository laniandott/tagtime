import type { FastifyInstance, FastifyReply } from 'fastify'
import prisma from '../db.js'
import { singleQueryString } from './query.js'
import { activityDueDate } from '../activity-rules.js'

const TODO_STATUSES = new Set(['pending', 'done'])
const TODO_REPEAT_TYPES = new Set(['none', 'daily', 'weekly', 'monthly'])
const MAX_TITLE_LENGTH = 300
const MAX_DESCRIPTION_LENGTH = 10000
const MAX_LATE_REASON_LENGTH = 500

type TodoRecord = {
  id: string
  title: string
  description: string | null
  priority: number
  dueDate: Date | null
  categoryId: string | null
  tagId: string | null
  goalId: string | null
  repeatType: string
}

function parsePriority(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 2) throw new Error('priority 必须是 0 到 2 的整数')
  return value as number
}

function parseDueDate(value: unknown): Date | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (typeof value !== 'string' || !value.trim()) throw new Error('dueDate 不是有效时间')
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error('dueDate 不是有效时间')
  return date
}

function parseRepeatType(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !TODO_REPEAT_TYPES.has(value)) throw new Error('repeatType 无效')
  return value
}

function parseLateReason(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (typeof value !== 'string' || value.trim().length > MAX_LATE_REASON_LENGTH) {
    const error = new Error(`lateReason 不能超过 ${MAX_LATE_REASON_LENGTH} 个字符`) as Error & { statusCode?: number }
    error.statusCode = 400
    throw error
  }
  return value.trim()
}

function parseRestoreReason(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (typeof value !== 'string' || value.trim().length > MAX_LATE_REASON_LENGTH) {
    const error = new Error(`restoreReason 不能超过 ${MAX_LATE_REASON_LENGTH} 个字符`) as Error & { statusCode?: number }
    error.statusCode = 400
    throw error
  }
  return value.trim()
}

function nextRepeatDate(date: Date, repeatType: string): Date | null {
  const next = new Date(date)
  if (repeatType === 'daily') next.setDate(next.getDate() + 1)
  else if (repeatType === 'weekly') next.setDate(next.getDate() + 7)
  else if (repeatType === 'monthly') {
    const day = next.getDate()
    next.setDate(1)
    next.setMonth(next.getMonth() + 1)
    const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate()
    next.setDate(Math.min(day, lastDay))
  } else return null
  return next
}

async function getTag(tagId: unknown, categoryId: unknown, reply: FastifyReply) {
  if (tagId !== undefined && tagId !== null && typeof tagId !== 'string') {
    reply.code(400).send({ error: 'tagId 无效' })
    return null
  }
  if (!tagId) return undefined
  const tag = await prisma.tag.findUnique({ where: { id: tagId }, select: { id: true, categoryId: true, parentId: true } })
  if (!tag) {
    reply.code(404).send({ error: '标签不存在' })
    return null
  }
  if (!tag.parentId) {
    reply.code(400).send({ error: '活动必须挂在二级标签下' })
    return null
  }
  if (categoryId && tag.categoryId !== categoryId) {
    reply.code(400).send({ error: '活动标签必须属于所选分类' })
    return null
  }
  return tag
}

async function recordCompletionInTimeEntry(todo: Pick<TodoRecord, 'title' | 'tagId'>, completedAt: Date) {
  if (!todo.tagId) return
  const activityTag = await prisma.tag.findUnique({ where: { id: todo.tagId }, select: { parentId: true } })
  if (!activityTag?.parentId) return
  const matchingEntry = await prisma.timeEntry.findFirst({
    where: {
      tagId: activityTag.parentId,
      dismissed: false,
      startTime: { lte: completedAt },
      OR: [{ endTime: null }, { endTime: { gte: completedAt } }],
    },
    orderBy: { startTime: 'desc' },
  })
  if (!matchingEntry) return
  await prisma.memo.create({
    data: {
      content: todo.title,
      type: 'point',
      timeEntryId: matchingEntry.id,
      tagId: activityTag.parentId,
      createdAt: completedAt,
    },
  })
}

async function completeTodo(todo: TodoRecord, lateReason: string | null | undefined) {
  const completedAt = new Date()
  if (todo.dueDate && completedAt > todo.dueDate && !lateReason?.trim()) {
    const error = new Error('活动已超时，请填写超时原因') as Error & { statusCode?: number }
    error.statusCode = 400
    throw error
  }

  // 抢占式更新避免快速重复点击生成多个下一周期实例。
  const claimed = await prisma.todo.updateMany({
    where: { id: todo.id, status: 'pending' },
    data: { status: 'done', completedAt, lateReason: lateReason?.trim() || null },
  })
  if (claimed.count === 0) {
    return prisma.todo.findUnique({ where: { id: todo.id }, include: { category: true, tag: true } })
  }
  const updated = await prisma.todo.findUniqueOrThrow({ where: { id: todo.id }, include: { category: true, tag: true } })
  await recordCompletionInTimeEntry(updated, completedAt)

  const activityGoal = updated.goalId
    ? await prisma.goal.findUnique({
      where: { id: updated.goalId },
      select: { id: true, title: true, tagId: true, kind: true, period: true, deadlineTime: true, deadlineDay: true, deadlineAt: true, active: true },
    })
    : null
  if (activityGoal?.kind === 'activity' && activityGoal.active && updated.dueDate) {
    const nextDueDate = activityDueDate(activityGoal, updated.dueDate, 1)
    if (nextDueDate) {
      const existingNext = await prisma.todo.findFirst({
        where: { goalId: activityGoal.id, status: 'pending', dueDate: nextDueDate },
        select: { id: true },
      })
      if (existingNext) return updated
      await prisma.todo.create({
        data: {
          title: activityGoal.title,
          description: updated.description,
          priority: updated.priority,
          dueDate: nextDueDate,
          categoryId: updated.categoryId,
          tagId: updated.tagId,
          goalId: activityGoal.id,
          repeatType: activityGoal.period,
        },
      })
    }
  } else if (updated.repeatType !== 'none' && updated.dueDate) {
    const nextDueDate = nextRepeatDate(updated.dueDate, updated.repeatType)
    if (nextDueDate) {
      await prisma.todo.create({
        data: {
          title: updated.title,
          description: updated.description,
          priority: updated.priority,
          dueDate: nextDueDate,
          categoryId: updated.categoryId,
          tagId: updated.tagId,
          goalId: updated.goalId,
          repeatType: updated.repeatType,
        },
      })
    }
  }
  return updated
}

export default async function todoRoutes(app: FastifyInstance) {
  app.get('/', async (req, reply) => {
    const raw = req.query as Record<string, unknown>
    const status = singleQueryString(raw.status)
    const categoryId = singleQueryString(raw.categoryId)
    const tagId = singleQueryString(raw.tagId)
    const repeatType = singleQueryString(raw.repeatType)
    if (status === null || categoryId === null || tagId === null || repeatType === null) {
      return reply.code(400).send({ error: '查询参数必须是单个字符串' })
    }
    const where: Record<string, unknown> = {}
    if (status && !TODO_STATUSES.has(status)) return reply.code(400).send({ error: 'status 无效' })
    if (repeatType && !TODO_REPEAT_TYPES.has(repeatType)) return reply.code(400).send({ error: 'repeatType 无效' })
    if (status) where.status = status
    if (categoryId) where.categoryId = categoryId
    if (tagId) where.tagId = tagId
    if (repeatType) where.repeatType = repeatType
    return prisma.todo.findMany({
      where,
      orderBy: [{ status: 'asc' }, { dueDate: 'asc' }, { completedAt: 'desc' }, { createdAt: 'desc' }],
      include: { category: true, tag: true, _count: { select: { timeEntries: true } } },
    })
  })

  app.post('/', async (req, reply) => {
    const { title, description, priority, dueDate, categoryId, tagId, repeatType } = (req.body ?? {}) as {
      title: string
      description?: string
      priority?: number
      dueDate?: string
      categoryId?: string
      tagId?: string
      repeatType?: string
    }
    if (typeof title !== 'string' || !title.trim() || title.length > MAX_TITLE_LENGTH) {
      return reply.code(400).send({ error: `标题不能为空且不能超过 ${MAX_TITLE_LENGTH} 个字符` })
    }
    if (description !== undefined && description !== null && (typeof description !== 'string' || description.length > MAX_DESCRIPTION_LENGTH)) {
      return reply.code(400).send({ error: `描述不能超过 ${MAX_DESCRIPTION_LENGTH} 个字符` })
    }
    let safePriority: number | undefined
    let safeDueDate: Date | null | undefined
    let safeRepeatType: string | undefined
    try {
      safePriority = parsePriority(priority)
      safeDueDate = parseDueDate(dueDate)
      safeRepeatType = parseRepeatType(repeatType)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : '待办参数无效' })
    }
    if (categoryId !== undefined && categoryId !== null && typeof categoryId !== 'string') return reply.code(400).send({ error: 'categoryId 无效' })
    if (categoryId) {
      const category = await prisma.category.findUnique({ where: { id: categoryId }, select: { id: true } })
      if (!category) return reply.code(404).send({ error: '分类不存在' })
    }
    const tag = await getTag(tagId, categoryId, reply)
    if (tag === null) return
    const resolvedCategoryId = categoryId ?? tag?.categoryId ?? null
    if (safeRepeatType && safeRepeatType !== 'none' && !safeDueDate) return reply.code(400).send({ error: '循环活动必须设置截止时间' })
    return prisma.todo.create({
      data: {
        title: title.trim(),
        description: description ?? undefined,
        priority: safePriority ?? 0,
        dueDate: safeDueDate ?? null,
        categoryId: resolvedCategoryId,
        tagId: tag?.id ?? null,
        repeatType: safeRepeatType ?? 'none',
      },
      include: { category: true, tag: true },
    })
  })

  app.put('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { title, description, status, priority, dueDate, categoryId, tagId, repeatType, lateReason, restoreReason } = (req.body ?? {}) as {
      title?: string
      description?: string | null
      status?: string
      priority?: number
      dueDate?: string | null
      categoryId?: string | null
      tagId?: string | null
      repeatType?: string
      lateReason?: string | null
      restoreReason?: string | null
    }
    const existing = await prisma.todo.findUnique({ where: { id } })
    if (!existing) return reply.code(404).send({ error: '待办不存在' })
    if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.length > MAX_TITLE_LENGTH)) return reply.code(400).send({ error: `标题不能为空且不能超过 ${MAX_TITLE_LENGTH} 个字符` })
    if (description !== undefined && description !== null && (typeof description !== 'string' || description.length > MAX_DESCRIPTION_LENGTH)) return reply.code(400).send({ error: `描述不能超过 ${MAX_DESCRIPTION_LENGTH} 个字符` })
    if (status !== undefined && !TODO_STATUSES.has(status)) return reply.code(400).send({ error: 'status 无效' })
    if (categoryId !== undefined && categoryId !== null && typeof categoryId !== 'string') return reply.code(400).send({ error: 'categoryId 无效' })
    let safePriority: number | undefined
    let safeDueDate: Date | null | undefined
    let safeRepeatType: string | undefined
    let safeLateReason: string | null | undefined
    let safeRestoreReason: string | null | undefined
    try {
      safePriority = parsePriority(priority)
      safeDueDate = parseDueDate(dueDate)
      safeRepeatType = parseRepeatType(repeatType)
      safeLateReason = parseLateReason(lateReason)
      safeRestoreReason = parseRestoreReason(restoreReason)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : '待办参数无效' })
    }
    const tag = await getTag(tagId, categoryId, reply)
    if (tag === null) return
    const resolvedCategoryId = categoryId !== undefined ? categoryId : tag?.categoryId ?? undefined
    const nextDueDate = safeDueDate !== undefined ? safeDueDate : existing.dueDate
    const nextRepeatType = safeRepeatType ?? existing.repeatType
    if (nextRepeatType !== 'none' && !nextDueDate) return reply.code(400).send({ error: '循环活动必须设置截止时间' })
    const restoring = status === 'pending' && existing.status === 'done'
    if (restoring && !safeRestoreReason?.trim()) return reply.code(400).send({ error: '恢复未完成必须填写恢复原因' })
    const edited = await prisma.todo.update({
      where: { id },
      data: {
        ...(title !== undefined ? { title: title.trim() } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(status !== undefined && status !== 'done'
          ? { status, completedAt: null, lateReason: null, restoreReason: restoring ? safeRestoreReason : null }
          : {}),
        ...(safePriority !== undefined ? { priority: safePriority } : {}),
        ...(safeDueDate !== undefined ? { dueDate: safeDueDate } : {}),
        ...(safeRepeatType !== undefined ? { repeatType: safeRepeatType } : {}),
        ...(categoryId !== undefined ? { categoryId: resolvedCategoryId } : tagId !== undefined ? { categoryId: resolvedCategoryId } : {}),
        ...(tagId !== undefined ? { tagId: tag?.id ?? null } : {}),
      },
    })
    if (status === 'done' && existing.status !== 'done') {
      try {
        return await completeTodo(edited, safeLateReason)
      } catch (error: any) {
        if (error?.statusCode) return reply.code(error.statusCode).send({ error: error.message })
        throw error
      }
    }
    return prisma.todo.findUnique({ where: { id: edited.id }, include: { category: true, tag: true } })
  })

  app.patch('/:id/toggle', async (req, reply) => {
    const { id } = req.params as { id: string }
    const todo = await prisma.todo.findUnique({ where: { id } })
    if (!todo) return reply.code(404).send({ error: '待办不存在' })
    if (todo.status === 'done') {
      try {
        const restoreReason = parseRestoreReason((req.body as any)?.restoreReason)
        if (!restoreReason?.trim()) return reply.code(400).send({ error: '恢复未完成必须填写恢复原因' })
        const restored = await prisma.todo.updateMany({
          where: { id, status: 'done' },
          data: { status: 'pending', completedAt: null, lateReason: null, restoreReason },
        })
        return prisma.todo.findUnique({ where: { id }, include: { category: true, tag: true } })
      } catch (error: any) {
        if (error?.statusCode) return reply.code(error.statusCode).send({ error: error.message })
        throw error
      }
    }
    try {
      return await completeTodo(todo, parseLateReason((req.body as any)?.lateReason))
    } catch (error: any) {
      if (error?.statusCode) return reply.code(error.statusCode).send({ error: error.message })
      throw error
    }
  })

  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    try {
      await prisma.todo.delete({ where: { id } })
    } catch {
      return reply.code(404).send({ error: '待办不存在' })
    }
    return { ok: true }
  })
}
