import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'

export default async function categoryRoutes(app: FastifyInstance) {
  // 列出所有分类（按 sortOrder 排序）
  app.get('/', async () => {
    return prisma.category.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: { _count: { select: { tags: true } } },
    })
  })

  // 创建分类
  app.post('/', async (req, reply) => {
    const { name, color, icon, sortOrder } = req.body as {
      name: string
      color?: string
      icon?: string
      sortOrder?: number
    }
    try {
      const category = await prisma.category.create({
        data: { name, color, icon, sortOrder },
      })
      return category
    } catch (e) {
      reply.code(400)
      return { error: '创建失败，名称可能已存在' }
    }
  })

  // 更新分类
  app.put('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { name, color, icon, sortOrder } = req.body as {
      name?: string
      color?: string
      icon?: string
      sortOrder?: number
    }
    try {
      return await prisma.category.update({
        where: { id },
        data: { name, color, icon, sortOrder },
      })
    } catch (e) {
      reply.code(404)
      return { error: '分类不存在' }
    }
  })

  // 删除分类（标签的 categoryId 置空）
  app.delete('/:id', async (req) => {
    const { id } = req.params as { id: string }
    await prisma.category.delete({ where: { id } })
    return { ok: true }
  })
}
