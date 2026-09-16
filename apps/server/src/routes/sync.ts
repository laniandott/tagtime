import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'

type Bucket = 'categories' | 'tags' | 'timeEntries' | 'todos' | 'goals' | 'memos'
type WireRecord = Record<string, unknown> & { id: string; deleted?: boolean }
type SyncBody = { cursor?: number } & Partial<Record<Bucket, WireRecord[]>>
const buckets: Bucket[] = ['categories', 'tags', 'timeEntries', 'todos', 'goals', 'memos']
const writable: Record<Bucket, string[]> = {
  categories: ['id', 'name', 'color', 'icon', 'sortOrder', 'createdAt', 'updatedAt'],
  tags: ['id', 'name', 'color', 'icon', 'categoryId', 'parentId', 'trackType', 'mode', 'sortOrder', 'createdAt', 'updatedAt'],
  timeEntries: ['id', 'startTime', 'endTime', 'note', 'tagId', 'todoId', 'pendingResume', 'dismissed', 'dismissReason', 'resumedFromId', 'interruptedFromId', 'createdAt'],
  todos: ['id', 'title', 'description', 'status', 'priority', 'dueDate', 'categoryId', 'tagId', 'goalId', 'repeatType', 'completedAt', 'lateReason', 'restoreReason', 'createdAt', 'updatedAt'],
  goals: ['id', 'tagId', 'title', 'kind', 'type', 'target', 'period', 'periodDays', 'deadlineTime', 'deadlineDay', 'deadlineAt', 'active', 'createdAt', 'updatedAt'],
  memos: ['id', 'content', 'type', 'timeEntryId', 'tagId', 'createdAt', 'updatedAt'],
}

function modelFor(bucket: Bucket): any {
  const name = bucket === 'categories' ? 'category' : bucket === 'timeEntries' ? 'timeEntry' : bucket.slice(0, -1)
  return (prisma as any)[name]
}

function clean(bucket: Bucket, record: WireRecord): Record<string, unknown> {
  return Object.fromEntries(writable[bucket].filter((key) => key in record).map((key) => [key, record[key]]))
}

async function snapshot() {
  const [categories, tags, timeEntries, todos, goals, memos] = await Promise.all([
    prisma.category.findMany({ orderBy: { createdAt: 'asc' } }), prisma.tag.findMany({ orderBy: { createdAt: 'asc' } }),
    prisma.timeEntry.findMany({ orderBy: { startTime: 'asc' } }), prisma.todo.findMany({ orderBy: { createdAt: 'asc' } }),
    prisma.goal.findMany({ orderBy: { createdAt: 'asc' } }), prisma.memo.findMany({ orderBy: { createdAt: 'asc' }, include: { attachments: true } }),
  ])
  const revision = Date.now()
  return { revision, cursor: revision, categories, tags, timeEntries, todos, goals, memos }
}

export default async function syncRoutes(app: FastifyInstance) {
  app.get('/', async () => ({ ...(await snapshot()), updatedAt: new Date().toISOString() }))
  app.post('/', async (req, reply) => {
    const body = (req.body ?? {}) as SyncBody
    if (typeof body.cursor !== 'number' || !Number.isFinite(body.cursor) || body.cursor < 0) return reply.code(400).send({ error: 'cursor 必须是有效的数字' })
    for (const bucket of buckets) if (body[bucket] !== undefined && !Array.isArray(body[bucket])) return reply.code(400).send({ error: `${bucket} 必须是数组` })

    for (const bucket of buckets) for (const record of body[bucket] ?? []) {
      if (!record || typeof record.id !== 'string' || !record.id || record.deleted) continue
      const data = clean(bucket, record)
      await modelFor(bucket).upsert({ where: { id: record.id }, create: data, update: data })
    }
    for (const bucket of [...buckets].reverse()) {
      const ids = (body[bucket] ?? []).filter((record) => record?.deleted && typeof record.id === 'string').map((record) => record.id)
      if (ids.length) await modelFor(bucket).deleteMany({ where: { id: { in: ids } } })
    }
    return { ...(await snapshot()), updatedAt: new Date().toISOString() }
  })
}
