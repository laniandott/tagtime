import type { FastifyInstance, FastifyReply } from 'fastify'
import prisma from '../db.js'

type SyncExchangeBody = {
  cursor: number
  categories: any[]
  tags: any[]
  timeEntries: any[]
  todos: any[]
  goals: any[]
  memos: any[]
  attachments: any[]
}

type SyncExchangeResult = {
  cursor: number
  categories: any[]
  tags: any[]
  timeEntries: any[]
  todos: any[]
  goals: any[]
  memos: any[]
  attachments: any[]
  updatedAt: string
}

export default async function syncRoutes(app: FastifyInstance) {
  // 1. 全量快照
  app.get('/', async (_req, reply) => {
    const [categories, tags, timeEntries, todos, goals, memos, attachments] = await Promise.all([
      prisma.category.findMany({ orderBy: { createdAt: 'asc' } }),
      prisma.tag.findMany({ orderBy: { createdAt: 'asc' } }),
      prisma.timeEntry.findMany({ orderBy: { startTime: 'asc' } }),
      prisma.todo.findMany({ orderBy: { createdAt: 'asc' } }),
      prisma.goal.findMany({ orderBy: { createdAt: 'asc' } }),
      prisma.memo.findMany({ orderBy: { createdAt: 'asc' }, include: { attachments: true } }),
      prisma.attachment.findMany({ orderBy: { createdAt: 'asc' } }),
    ])

    const cursor = Date.now()
    const result: SyncExchangeResult = {
      cursor,
      categories,
      tags,
      timeEntries,
      todos,
      goals,
      memos,
      attachments,
      updatedAt: new Date().toISOString(),
    }

    return result
  })

  // 2. 增量交换
  app.post('/', async (req, reply) => {
    const body = (req.body ?? {}) as Partial<SyncExchangeBody>

    if (typeof body.cursor !== 'number' || !Number.isFinite(body.cursor) || body.cursor < 0) {
      return reply.code(400).send({ error: 'cursor 必须是有效的数字' })
    }

    const ingest = async <T extends { id: string }>(
      bucket: any[],
      input: unknown,
      model: any,
    ): Promise<T[]> => {
      if (!Array.isArray(input)) return []
      const ids = input.map((item) => item?.id).filter(Boolean)
      if (!ids.length) return []

      const existing = await model.findMany({
        where: { id: { in: ids as string[] } },
      })
      const existingMap = new Map(existing.map((item: any) => [item.id, item]))

      const toUpsert: any[] = []
      for (const raw of input) {
        if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') continue
        const current = existingMap.get(raw.id)
        const incomingUpdatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : ''
        const currentUpdatedAt = typeof current?.updatedAt === 'string' ? current.updatedAt : ''
        if (!current || incomingUpdatedAt > currentUpdatedAt) {
          toUpsert.push({ ...raw, updatedAt: new Date().toISOString() })
        }
      }

      if (!toUpsert.length) return []

      try {
        const created = await model.createMany({
          data: toUpsert,
          skipDuplicates: true,
        })
        const affected = created.count || toUpsert.length
        if (affected > 0) {
          const refreshed = await model.findMany({
            where: { id: { in: toUpsert.map((item) => item.id) } },
          })
          return refreshed as T[]
        }
        return []
      } catch {
        // createMany 不支持所有字段；回退到逐条 upsert。
        const results: T[] = []
        for (const item of toUpsert) {
          const updated = await model.upsert({
            where: { id: item.id },
            update: item,
            create: item,
          })
          results.push(updated as T)
        }
        return results
      }
    }

    const [categories, tags, timeEntries, todos, goals, memos, attachments] = await Promise.all([
      ingest(body.categories, body.categories, prisma.category),
      ingest(body.tags, body.tags, prisma.tag),
      ingest(body.timeEntries, body.timeEntries, prisma.timeEntry),
      ingest(body.todos, body.todos, prisma.todo),
      ingest(body.goals, body.goals, prisma.goal),
      ingest(body.memos, body.memos, prisma.memo),
      ingest(body.attachments, body.attachments, prisma.attachment),
    ])

    const cursor = Date.now()
    const result: SyncExchangeResult = {
      cursor,
      categories,
      tags,
      timeEntries,
      todos,
      goals,
      memos,
      attachments,
      updatedAt: new Date().toISOString(),
    }

    return result
  })
}
