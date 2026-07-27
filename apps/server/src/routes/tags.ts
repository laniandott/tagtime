import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'

export default async function tagRoutes(app: FastifyInstance) {
  // 列出所有标签（含分类信息）
  app.get('/', async () => {
    return prisma.tag.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: { category: true },
    })
  })

  // 创建标签
  app.post('/', async (req, reply) => {
    const { name, color, icon, categoryId, sortOrder, trackType } = req.body as {
      name: string
      color?: string
      icon?: string
      categoryId?: string
      sortOrder?: number
      trackType?: string
    }
    try {
      return await prisma.tag.create({
        data: { name, color, icon, categoryId: categoryId || null, sortOrder, trackType: trackType ?? 'time' },
        include: { category: true },
      })
    } catch (e) {
      reply.code(400)
      return { error: '创建失败，该分类下名称可能已存在' }
    }
  })

  // 更新标签
  app.put('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { name, color, icon, categoryId, sortOrder, trackType } = req.body as {
      name?: string
      color?: string
      icon?: string
      categoryId?: string | null
      sortOrder?: number
      trackType?: string
    }
    try {
      return await prisma.tag.update({
        where: { id },
        data: { name, color, icon, categoryId, sortOrder, trackType },
        include: { category: true },
      })
    } catch (e) {
      reply.code(404)
      return { error: '标签不存在' }
    }
  })

  // 删除标签（若有关联时间记录则拒绝，保护历史数据）
  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const count = await prisma.timeEntry.count({ where: { tagId: id } })
    if (count > 0) {
      reply.code(409)
      return {
        error: `该标签有 ${count} 条时间记录，删除会丢失历史统计。请先迁移记录或归档标签。`,
      }
    }
    await prisma.tag.delete({ where: { id } })
    return { ok: true }
  })
}
