import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'
import { singleQueryString } from './query.js'

const TODO_STATUSES = new Set(['pending', 'done'])
const MAX_TITLE_LENGTH = 300
const MAX_DESCRIPTION_LENGTH = 10000

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

export default async function todoRoutes(app: FastifyInstance) {
  // 列出待办（支持按状态筛选）
  app.get('/', async (req, reply) => {
    const raw = req.query as Record<string, unknown>
    const status = singleQueryString(raw.status)
    const categoryId = singleQueryString(raw.categoryId)
    if (status === null || categoryId === null) return reply.code(400).send({ error: '查询参数必须是单个字符串' })
    const where: Record<string, unknown> = {}
    if (status && !TODO_STATUSES.has(status)) return reply.code(400).send({ error: 'status 无效' })
    if (status) where.status = status
    if (categoryId) where.categoryId = categoryId
    return prisma.todo.findMany({
      where,
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
      include: {
        category: true,
        _count: { select: { timeEntries: true } },
      },
    })
  })

  // 创建待办
  app.post('/', async (req, reply) => {
    const { title, description, priority, dueDate, categoryId } = (req.body ?? {}) as {
      title: string
      description?: string
      priority?: number
      dueDate?: string
      categoryId?: string
    }
    if (typeof title !== 'string' || !title.trim() || title.length > MAX_TITLE_LENGTH) {
      return reply.code(400).send({ error: `标题不能为空且不能超过 ${MAX_TITLE_LENGTH} 个字符` })
    }
    if (description !== undefined && description !== null && (typeof description !== 'string' || description.length > MAX_DESCRIPTION_LENGTH)) {
      return reply.code(400).send({ error: `描述不能超过 ${MAX_DESCRIPTION_LENGTH} 个字符` })
    }
    let safePriority: number | undefined
    let safeDueDate: Date | null | undefined
    try {
      safePriority = parsePriority(priority)
      safeDueDate = parseDueDate(dueDate)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : '待办参数无效' })
    }
    if (categoryId !== undefined && categoryId !== null && typeof categoryId !== 'string') {
      return reply.code(400).send({ error: 'categoryId 无效' })
    }
    if (categoryId) {
      const category = await prisma.category.findUnique({ where: { id: categoryId }, select: { id: true } })
      if (!category) return reply.code(404).send({ error: '分类不存在' })
    }
    return prisma.todo.create({
      data: {
        title: title.trim(),
        description: description ?? undefined,
        priority: safePriority ?? 0,
        dueDate: safeDueDate ?? null,
        categoryId: categoryId || null,
      },
      include: { category: true },
    })
  })

  // 更新待办
  app.put('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { title, description, status, priority, dueDate, categoryId } = (req.body ?? {}) as {
      title?: string
      description?: string
      status?: string
      priority?: number
      dueDate?: string | null
      categoryId?: string | null
    }
    if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.length > MAX_TITLE_LENGTH)) {
      return reply.code(400).send({ error: `标题不能为空且不能超过 ${MAX_TITLE_LENGTH} 个字符` })
    }
    if (description !== undefined && description !== null && (typeof description !== 'string' || description.length > MAX_DESCRIPTION_LENGTH)) {
      return reply.code(400).send({ error: `描述不能超过 ${MAX_DESCRIPTION_LENGTH} 个字符` })
    }
    if (status !== undefined && !TODO_STATUSES.has(status)) return reply.code(400).send({ error: 'status 无效' })
    if (categoryId !== undefined && categoryId !== null && typeof categoryId !== 'string') {
      return reply.code(400).send({ error: 'categoryId 无效' })
    }
    let safePriority: number | undefined
    let safeDueDate: Date | null | undefined
    try {
      safePriority = parsePriority(priority)
      safeDueDate = parseDueDate(dueDate)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : '待办参数无效' })
    }
    if (categoryId) {
      const category = await prisma.category.findUnique({ where: { id: categoryId }, select: { id: true } })
      if (!category) return reply.code(404).send({ error: '分类不存在' })
    }
    const existing = await prisma.todo.findUnique({ where: { id } })
    if (!existing) return reply.code(404).send({ error: '待办不存在' })
    return prisma.todo.update({
      where: { id },
      data: {
        ...(title !== undefined ? { title: title.trim() } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(safePriority !== undefined ? { priority: safePriority } : {}),
        ...(safeDueDate !== undefined ? { dueDate: safeDueDate } : {}),
        ...(categoryId !== undefined ? { categoryId } : {}),
      },
      include: { category: true },
    })
  })

  // 切换待办状态
  app.patch('/:id/toggle', async (req, reply) => {
    const { id } = req.params as { id: string }
    const todo = await prisma.todo.findUnique({ where: { id } })
    if (!todo) {
      reply.code(404)
      return { error: '待办不存在' }
    }
    return prisma.todo.update({
      where: { id },
      data: { status: todo.status === 'done' ? 'pending' : 'done' },
    })
  })

  // 删除待办
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
