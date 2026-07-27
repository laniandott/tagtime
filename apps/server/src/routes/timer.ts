import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'

export default async function timerRoutes(app: FastifyInstance) {
  // 开始计时：传入 tagId，可选 note、todoId
  // 支持同步计时——不会自动结束其他进行中的计时
  app.post('/start', async (req) => {
    const { tagId, note, todoId } = req.body as {
      tagId: string
      note?: string
      todoId?: string
    }
    const entry = await prisma.timeEntry.create({
      data: { tagId, note, todoId: todoId || null },
      include: { tag: { include: { category: true } } },
    })
    return { ...entry, serverTime: new Date().toISOString() }
  })

  // 结束指定计时：POST /stop/:id
  app.post('/stop/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { note } = (req.body as { note?: string }) ?? {}
    const entry = await prisma.timeEntry.findUnique({ where: { id } })
    if (!entry || entry.endTime) {
      reply.code(404)
      return { error: '计时不存在或已结束' }
    }
    return prisma.timeEntry.update({
      where: { id },
      data: { endTime: new Date(), note: note ?? entry.note },
      include: { tag: { include: { category: true } } },
    })
  })

  // 结束所有进行中的计时：POST /stop
  app.post('/stop', async () => {
    const result = await prisma.timeEntry.updateMany({
      where: { endTime: null },
      data: { endTime: new Date() },
    })
    return { count: result.count }
  })

  // 获取所有进行中的计时（含 serverTime 用于时钟同步）
  app.get('/current', async () => {
    const running = await prisma.timeEntry.findMany({
      where: { endTime: null },
      include: { tag: { include: { category: true } }, todo: true },
      orderBy: { startTime: 'asc' },
    })
    return { running, serverTime: new Date().toISOString() }
  })

  // 列出时间记录（支持日期范围筛选）
  app.get('/', async (req) => {
    const { from, to, tagId } = req.query as {
      from?: string
      to?: string
      tagId?: string
    }
    const where: Record<string, unknown> = {}
    if (tagId) where.tagId = tagId
    if (from || to) {
      where.startTime = {}
      if (from) (where.startTime as { gte?: Date }).gte = new Date(from)
      if (to) (where.startTime as { lte?: Date }).lte = new Date(to)
    }
    return prisma.timeEntry.findMany({
      where,
      orderBy: { startTime: 'desc' },
      include: { tag: { include: { category: true } }, todo: true },
      take: 500,
    })
  })

  // 删除一条时间记录
  app.delete('/:id', async (req) => {
    const { id } = req.params as { id: string }
    await prisma.timeEntry.delete({ where: { id } })
    return { ok: true }
  })

  // 手动补录：指定起止时间、标签、备注，创建一条已完成的时间记录
  app.post('/manual', async (req, reply) => {
    const { tagId, startTime, endTime, note, todoId } = req.body as {
      tagId: string
      startTime: string
      endTime: string
      note?: string
      todoId?: string
    }
    if (!tagId || !startTime || !endTime) {
      reply.code(400)
      return { error: 'tagId、startTime、endTime 为必填' }
    }
    const start = new Date(startTime)
    const end = new Date(endTime)
    if (end <= start) {
      reply.code(400)
      return { error: '结束时间必须晚于开始时间' }
    }
    return prisma.timeEntry.create({
      data: {
        tagId,
        startTime: start,
        endTime: end,
        note,
        todoId: todoId || null,
      },
      include: { tag: { include: { category: true } } },
    })
  })

  // 手动编辑时间记录（补录/修正）
  app.put('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { startTime, endTime, note, tagId } = req.body as {
      startTime?: string
      endTime?: string | null
      note?: string
      tagId?: string
    }
    try {
      return await prisma.timeEntry.update({
        where: { id },
        data: {
          startTime: startTime ? new Date(startTime) : undefined,
          endTime: endTime === null ? null : endTime ? new Date(endTime) : undefined,
          note,
          tagId,
        },
      })
    } catch (e) {
      reply.code(404)
      return { error: '记录不存在' }
    }
  })
}
