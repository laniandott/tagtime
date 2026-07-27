import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'

export default async function todoRoutes(app: FastifyInstance) {
  // 列出待办（支持按状态筛选）
  app.get('/', async (req) => {
    const { status, categoryId } = req.query as {
      status?: string
      categoryId?: string
    }
    const where: Record<string, unknown> = {}
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
  app.post('/', async (req) => {
    const { title, description, priority, dueDate, categoryId } = req.body as {
      title: string
      description?: string
      priority?: number
      dueDate?: string
      categoryId?: string
    }
    return prisma.todo.create({
      data: {
        title,
        description,
        priority: priority ?? 0,
        dueDate: dueDate ? new Date(dueDate) : null,
        categoryId: categoryId || null,
      },
      include: { category: true },
    })
  })

  // 更新待办
  app.put('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { title, description, status, priority, dueDate, categoryId } = req.body as {
      title?: string
      description?: string
      status?: string
      priority?: number
      dueDate?: string | null
      categoryId?: string | null
    }
    try {
      return await prisma.todo.update({
        where: { id },
        data: {
          title,
          description,
          status,
          priority,
          dueDate: dueDate === null ? null : dueDate ? new Date(dueDate) : undefined,
          categoryId,
        },
        include: { category: true },
      })
    } catch (e) {
      reply.code(404)
      return { error: '待办不存在' }
    }
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
  app.delete('/:id', async (req) => {
    const { id } = req.params as { id: string }
    await prisma.todo.delete({ where: { id } })
    return { ok: true }
  })
}
