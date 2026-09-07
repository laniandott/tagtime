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

type ChainEntry = {
  id: string
  startTime: Date
  endTime: Date | null
  resumedFromId: string | null
}

// 计算链条统计信息：向上回溯 resumedFromId 链
async function getChainStats(entryId: string): Promise<{
  rootId: string
  chainLength: number
  totalFocusedMs: number
  totalSpanMs: number
}> {
  const entries: ChainEntry[] = []
  let currentId: string | null = entryId

  // 向上回溯找到链条根节点
  while (currentId) {
    const entry: ChainEntry | null = await prisma.timeEntry.findUnique({
      where: { id: currentId },
      select: { id: true, startTime: true, endTime: true, resumedFromId: true }
    })
    if (!entry) break
    entries.unshift(entry)
    currentId = entry.resumedFromId
  }

  const rootId = entries[0]?.id || entryId
  const chainLength = entries.length

  // 计算总专注时长（各段 endTime - startTime 之和）
  let totalFocusedMs = 0
  for (const entry of entries) {
    if (entry.endTime) {
      totalFocusedMs += entry.endTime.getTime() - entry.startTime.getTime()
    }
  }

  // 计算总占位时长（第一段 startTime 到最后一段 endTime）
  const firstStart = entries[0]?.startTime
  const lastEnd = entries[entries.length - 1]?.endTime
  const totalSpanMs = firstStart && lastEnd ? lastEnd.getTime() - firstStart.getTime() : totalFocusedMs

  return { rootId, chainLength, totalFocusedMs, totalSpanMs }
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

  // 开始计时：传入 tagId，可选 note、todoId、resumedFromId、interruptedFromId
  // 支持同步计时——不会自动结束其他进行中的计时
  app.post('/start', async (req, reply) => {
    const { tagId, note, todoId, resumedFromId, interruptedFromId } = (req.body ?? {}) as {
      tagId: string
      note?: string
      todoId?: string
      resumedFromId?: string
      interruptedFromId?: string
    }
    if (!validateNote(note, reply)) return
    if (!await validateReferences(tagId, todoId, reply)) return
    if (resumedFromId && interruptedFromId) {
      return reply.code(400).send({ error: '续接和接管不能同时指定' })
    }

    // 续接逻辑：校验 resumedFromId
    let finalNote: string | undefined = note
    let finalTodoId: string | undefined = todoId
    if (resumedFromId) {
      const parentEntry = await prisma.timeEntry.findUnique({
        where: { id: resumedFromId },
        include: { tag: true }
      })
      if (!parentEntry) {
        return reply.code(404).send({ error: '原计时记录不存在' })
      }
      if (parentEntry.tagId !== tagId) {
        return reply.code(400).send({ error: '续接的 tagId 必须与原记录一致' })
      }
      if (!parentEntry.pendingResume) {
        return reply.code(400).send({ error: '原记录未处于待续状态' })
      }
      // 自动复制备注和 todoId（若未显式传入）
      if (finalNote === undefined) finalNote = parentEntry.note ?? undefined
      if (finalTodoId === undefined) finalTodoId = parentEntry.todoId ?? undefined

    }

    // 接管逻辑：当前活动是在某条待续记录暂停后开始的，保留中断关系但不消费待续记录。
    if (interruptedFromId) {
      const interruptedEntry = await prisma.timeEntry.findUnique({
        where: { id: interruptedFromId },
        select: { id: true, endTime: true, pendingResume: true },
      })
      if (!interruptedEntry) {
        return reply.code(404).send({ error: '被接管的活动记录不存在' })
      }
      if (!interruptedEntry.endTime || !interruptedEntry.pendingResume) {
        return reply.code(400).send({ error: '被接管的活动必须处于待续状态' })
      }
    }

    let entry
    try {
      entry = await prisma.$transaction(async (tx) => {
        if (resumedFromId) {
          const claimed = await tx.timeEntry.updateMany({
            where: { id: resumedFromId, pendingResume: true },
            data: { pendingResume: false },
          })
          if (claimed.count !== 1) throw new Error('RESUME_NOT_PENDING')
        }
        return tx.timeEntry.create({
          data: {
            tagId,
            note: finalNote,
            todoId: finalTodoId || null,
            resumedFromId: resumedFromId || null,
            interruptedFromId: interruptedFromId || null,
          },
          include: timeEntryInclude,
        })
      })
    } catch (error) {
      if (error instanceof Error && error.message === 'RESUME_NOT_PENDING') {
        return reply.code(400).send({ error: '原记录未处于待续状态' })
      }
      throw error
    }
    return { ...entry, serverTime: new Date().toISOString() }
  })

  // 结束指定计时：POST /stop/:id
  // 支持 pendingResume（有序 tag 可暂停）
  app.post('/stop/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { note, pendingResume } = (req.body ?? {}) as { note?: string; pendingResume?: boolean }
    if (!validateNote(note, reply)) return
    const entry = await prisma.timeEntry.findUnique({
      where: { id },
      include: { tag: true }
    })
    if (!entry || entry.endTime) {
      reply.code(404)
      return { error: '计时不存在或已结束' }
    }

    // 混沌/有序分流：混沌 tag 强制 pendingResume=false
    let finalPendingResume = false
    if (entry.tag.mode === 'ordered' && pendingResume === true) {
      // 有序 tag 允许暂停，但必须填写备注
      if (!note || !note.trim()) {
        return reply.code(400).send({ error: '有序标签暂停时必须填写"接下来怎么续"备注' })
      }
      finalPendingResume = true
    }
    // 混沌 tag：即使前端误传 pendingResume=true，后端也强制为 false

    return prisma.timeEntry.update({
      where: { id },
      data: {
        endTime: new Date(),
        note: note ?? entry.note,
        pendingResume: finalPendingResume
      },
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

  // 获取所有待续记录：GET /pending
  app.get('/pending', async () => {
    const pending = await prisma.timeEntry.findMany({
      where: { pendingResume: true },
      include: {
        tag: { include: { category: true } },
        todo: true,
      },
      orderBy: { endTime: 'desc' },
    })

    // 计算每条记录的链长度和总专注时长
    const enriched = await Promise.all(
      pending.map(async (entry) => {
        const stats = await getChainStats(entry.id)
        return {
          ...entry,
          chainLength: stats.chainLength,
          totalFocusedMs: stats.totalFocusedMs,
        }
      })
    )

    return {
      serverTime: new Date().toISOString(),
      pending: enriched,
    }
  })

  // "算了"操作：POST /timer/:id/dismiss-pending
  app.post('/:id/dismiss-pending', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { reason } = (req.body ?? {}) as { reason?: unknown }

    if (typeof reason !== 'string' || !reason.trim()) {
      return reply.code(400).send({ error: '必须填写原因' })
    }
    const trimmedReason = reason.trim()
    if (trimmedReason.length > CONTENT_LIMITS.TIMER_NOTE) {
      return reply.code(400).send({ error: `原因不能超过 ${CONTENT_LIMITS.TIMER_NOTE} 字符` })
    }

    const entry = await prisma.timeEntry.findUnique({ where: { id } })
    if (!entry) {
      return reply.code(404).send({ error: '记录不存在' })
    }
    if (!entry.pendingResume) {
      return reply.code(400).send({ error: '该记录未处于待续状态' })
    }

    // 更新记录：dismissed=true, pendingResume=false, note 尾部追加原因
    const updatedNote = entry.note ? `${entry.note}\n—— 已丢弃：${trimmedReason}` : `—— 已丢弃：${trimmedReason}`
    return prisma.timeEntry.update({
      where: { id },
      data: {
        pendingResume: false,
        dismissed: true,
        dismissReason: trimmedReason,
        note: updatedNote,
      },
      include: timeEntryInclude,
    })
  })

  // 结束一条待续意图，但不标记为放弃；用于用户在回退弹窗中选择“结束活动”。
  app.post('/:id/finish-pending', async (req, reply) => {
    const { id } = req.params as { id: string }
    const entry = await prisma.timeEntry.findUnique({ where: { id } })
    if (!entry) return reply.code(404).send({ error: '记录不存在' })
    if (!entry.pendingResume) return reply.code(400).send({ error: '该记录未处于待续状态' })
    return prisma.timeEntry.update({
      where: { id },
      data: { pendingResume: false },
      include: timeEntryInclude,
    })
  })

  // 终止当前活动及其上游中断链：保留历史时间，但要求留下具体原因。
  app.post('/:id/terminate-chain', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { reason } = (req.body ?? {}) as { reason?: unknown }
    if (typeof reason !== 'string' || !reason.trim()) {
      return reply.code(400).send({ error: '必须填写终止本次链路的具体原因' })
    }
    const trimmedReason = reason.trim()
    if (trimmedReason.length > CONTENT_LIMITS.TIMER_NOTE) {
      return reply.code(400).send({ error: `原因不能超过 ${CONTENT_LIMITS.TIMER_NOTE} 字符` })
    }

    const chain: { id: string; endTime: Date | null; interruptedFromId: string | null }[] = []
    const visited = new Set<string>()
    let currentId: string | null = id
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId)
      const entry: { id: string; endTime: Date | null; interruptedFromId: string | null } | null = await prisma.timeEntry.findUnique({
        where: { id: currentId },
        select: { id: true, endTime: true, interruptedFromId: true },
      })
      if (!entry) break
      chain.push(entry)
      currentId = entry.interruptedFromId
    }
    if (chain.length === 0) return reply.code(404).send({ error: '活动记录不存在' })

    const now = new Date()
    await prisma.$transaction(async (tx) => {
      for (const entry of chain) {
        await tx.timeEntry.update({
          where: { id: entry.id },
          data: {
            endTime: entry.endTime ?? now,
            pendingResume: false,
            dismissed: true,
            dismissReason: trimmedReason,
          },
        })
      }
    })
    return { count: chain.length }
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
    const { startTime, endTime, note, tagId, todoId } = (req.body ?? {}) as {
      startTime?: string
      endTime?: string | null
      note?: string
      tagId?: string
      todoId?: string | null
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
    if ((tagId !== undefined || todoId !== undefined) && !await validateReferences(tagId, todoId, reply, { requireTag: false })) return

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
        todoId: todoId !== undefined ? todoId : undefined,
      },
      include: timeEntryInclude,
    })
  })
}
