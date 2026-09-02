import type { FastifyInstance, FastifyReply } from 'fastify'
import prisma from '../db.js'
import { CONTENT_LIMITS } from '../config.js'
import { singleQueryString } from './query.js'

const timeEntryInclude = {
  tag: { include: { category: true } },
  todo: true,
  memos: {
    orderBy: { createdAt: 'asc' as const },
    include: { attachments: true },
  },
}

function parseDateInput(value: string, field: string): Date | { error: string } {
  if (typeof value !== 'string' || !value.trim()) return { error: `${field} 不是有效时间` }
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : { error: `${field} 不是有效时间` }
}

function validateNote(note: unknown, reply: FastifyReply): boolean {
  if (note !== undefined && note !== null && typeof note !== 'string') {
    reply.code(400).send({ error: 'note 必须是字符串' })
    return false
  }
  if (typeof note === 'string' && note.length > CONTENT_LIMITS.TIMER_NOTE) {
    reply.code(400).send({ error: `备注不能超过 ${CONTENT_LIMITS.TIMER_NOTE} 个字符` })
    return false
  }
  return true
}

async function validateReferences(
  tagId: unknown,
  todoId: unknown,
  reply: FastifyReply,
  options: { requireTag?: boolean } = {},
): Promise<boolean> {
  const requireTag = options.requireTag ?? true
  if (requireTag && (typeof tagId !== 'string' || !tagId.trim())) {
    reply.code(400).send({ error: 'tagId 为必填字符串' })
    return false
  }
  if (todoId !== undefined && todoId !== null && typeof todoId !== 'string') {
    reply.code(400).send({ error: 'todoId 必须是字符串' })
    return false
  }

  const [tag, todo] = await Promise.all([
    requireTag ? prisma.tag.findUnique({ where: { id: tagId as string }, select: { id: true } }) : null,
    typeof todoId === 'string' && todoId ? prisma.todo.findUnique({ where: { id: todoId }, select: { id: true } }) : null,
  ])
  if (requireTag && !tag) {
    reply.code(404).send({ error: '标签不存在' })
    return false
  }
  if (typeof todoId === 'string' && todoId && !todo) {
    reply.code(404).send({ error: '待办不存在' })
    return false
  }
  return true
}

export default async function timerRoutes(app: FastifyInstance) {
  // 次数型标签：点击即完成一条记录（startTime = endTime）
  app.post('/quick', async (req, reply) => {
    const { tagId, note, todoId } = (req.body ?? {}) as {
      tagId: string
      note?: string
      todoId?: string
    }
    if (!validateNote(note, reply)) return
    if (!await validateReferences(tagId, todoId, reply)) return
    const now = new Date()
    const entry = await prisma.timeEntry.create({
      data: {
        tagId,
        note,
        todoId: todoId || null,
        startTime: now,
        endTime: now,
      },
      include: timeEntryInclude,
    })
    return { ...entry, serverTime: now.toISOString() }
  })

  // 开始计时：传入 tagId，可选 note、todoId
  // 支持同步计时——不会自动结束其他进行中的计时
  app.post('/start', async (req, reply) => {
    const { tagId, note, todoId } = (req.body ?? {}) as {
      tagId: string
      note?: string
      todoId?: string
    }
    if (!validateNote(note, reply)) return
    if (!await validateReferences(tagId, todoId, reply)) return
    const entry = await prisma.timeEntry.create({
      data: { tagId, note, todoId: todoId || null },
      include: timeEntryInclude,
    })
    return { ...entry, serverTime: new Date().toISOString() }
  })

  // 结束指定计时：POST /stop/:id
  app.post('/stop/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { note } = (req.body ?? {}) as { note?: string }
    if (!validateNote(note, reply)) return
    const entry = await prisma.timeEntry.findUnique({ where: { id } })
    if (!entry || entry.endTime) {
      reply.code(404)
      return { error: '计时不存在或已结束' }
    }
    return prisma.timeEntry.update({
      where: { id },
      data: { endTime: new Date(), note: note ?? entry.note },
      include: timeEntryInclude,
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
      include: timeEntryInclude,
      orderBy: { startTime: 'asc' },
    })
    return { running, serverTime: new Date().toISOString() }
  })

  // 列出时间记录（支持日期范围筛选）
  app.get('/', async (req, reply) => {
    const raw = req.query as Record<string, unknown>
    const from = singleQueryString(raw.from)
    const to = singleQueryString(raw.to)
    const tagId = singleQueryString(raw.tagId)
    if (from === null || to === null || tagId === null) {
      return reply.code(400).send({ error: '查询参数必须是单个字符串' })
    }
    const where: Record<string, unknown> = {}
    if (tagId) where.tagId = tagId
    if (from || to) {
      const andCond: Record<string, unknown>[] = []
      const parsedTo = to ? parseDateInput(to, 'to') : null
      const parsedFrom = from ? parseDateInput(from, 'from') : null
      if (parsedTo && 'error' in parsedTo) return reply.code(400).send(parsedTo)
      if (parsedFrom && 'error' in parsedFrom) return reply.code(400).send(parsedFrom)
      if (parsedFrom && parsedTo && parsedTo < parsedFrom) {
        return reply.code(400).send({ error: 'to 不能早于 from' })
      }
      if (parsedTo && !('error' in parsedTo)) andCond.push({ startTime: { lte: parsedTo } })
      if (parsedFrom && !('error' in parsedFrom)) andCond.push({ OR: [{ endTime: { gte: parsedFrom } }, { endTime: null }] })
      where.AND = andCond
    }
    return prisma.timeEntry.findMany({
      where,
      orderBy: { startTime: 'desc' },
      include: timeEntryInclude,
      take: 500,
    })
  })

  // 删除一条时间记录
  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    try {
      await prisma.timeEntry.delete({ where: { id } })
    } catch {
      return reply.code(404).send({ error: '计时记录不存在' })
    }
    return { ok: true }
  })

  // 手动补录：指定起止时间、标签、备注，创建一条已完成的时间记录
  app.post('/manual', async (req, reply) => {
    const { tagId, startTime, endTime, note, todoId } = (req.body ?? {}) as {
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
    if (!validateNote(note, reply)) return
    if (!await validateReferences(tagId, todoId, reply)) return
    const start = parseDateInput(startTime, 'startTime')
    const end = parseDateInput(endTime, 'endTime')
    if ('error' in start) return reply.code(400).send(start)
    if ('error' in end) return reply.code(400).send(end)
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
      include: timeEntryInclude,
    })
  })

  // 手动编辑时间记录（补录/修正）
  app.put('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { startTime, endTime, note, tagId } = (req.body ?? {}) as {
      startTime?: string
      endTime?: string | null
      note?: string
      tagId?: string
    }
    if (!validateNote(note, reply)) return
    if (startTime !== undefined && typeof startTime !== 'string') {
      return reply.code(400).send({ error: 'startTime 必须是字符串' })
    }
    if (endTime !== undefined && endTime !== null && typeof endTime !== 'string') {
      return reply.code(400).send({ error: 'endTime 必须是字符串或 null' })
    }
    if (startTime !== undefined && (typeof startTime !== 'string' || !startTime.trim())) {
      return reply.code(400).send({ error: 'startTime 不是有效时间' })
    }
    if (typeof endTime === 'string' && !endTime.trim()) {
      return reply.code(400).send({ error: 'endTime 不是有效时间' })
    }
    const existing = await prisma.timeEntry.findUnique({ where: { id } })
    if (!existing) return reply.code(404).send({ error: '记录不存在' })
    if (tagId !== undefined && !await validateReferences(tagId, undefined, reply)) return

    const parsedStart = startTime !== undefined ? parseDateInput(startTime, 'startTime') : existing.startTime
    if ('error' in parsedStart) return reply.code(400).send(parsedStart)
    const parsedEnd = endTime === undefined
      ? existing.endTime
      : endTime === null
        ? null
        : parseDateInput(endTime, 'endTime')
    if (parsedEnd && 'error' in parsedEnd) return reply.code(400).send(parsedEnd)
    if (parsedEnd && parsedEnd < parsedStart) {
      return reply.code(400).send({ error: '结束时间不能早于开始时间' })
    }

    return prisma.timeEntry.update({
      where: { id },
      data: {
        startTime: startTime !== undefined ? parsedStart : undefined,
        endTime: endTime !== undefined ? parsedEnd : undefined,
        note,
        tagId,
      },
      include: timeEntryInclude,
    })
  })
}
