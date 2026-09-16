import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'

type Bucket = 'categories' | 'tags' | 'goals' | 'todos' | 'timeEntries' | 'memos'
type WireRecord = Record<string, unknown> & { id: string; deleted?: boolean }
type SyncBody = { cursor?: number } & Partial<Record<Bucket, WireRecord[]>>
// Parent records must exist before their children; deletion runs in reverse.
const buckets: Bucket[] = ['categories', 'tags', 'goals', 'todos', 'timeEntries', 'memos']
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

function dependencies(bucket: Bucket, record: WireRecord): string[] {
  if (bucket === 'tags') return typeof record.parentId === 'string' ? [record.parentId] : []
  if (bucket === 'todos') return typeof record.goalId === 'string' ? [record.goalId] : []
  if (bucket === 'timeEntries') return [record.todoId, record.resumedFromId, record.interruptedFromId].filter((id): id is string => typeof id === 'string')
  if (bucket === 'memos') return typeof record.timeEntryId === 'string' ? [record.timeEntryId] : []
  return []
}

function orderedRecords(bucket: Bucket, records: WireRecord[]): WireRecord[] {
  const remaining = records.filter((record) => record && typeof record.id === 'string' && !record.deleted)
  const ids = new Set(remaining.map((record) => record.id))
  const ordered: WireRecord[] = []
  while (remaining.length) {
    const index = remaining.findIndex((record) => dependencies(bucket, record).every((id) => !ids.has(id) || ordered.some((item) => item.id === id)))
    const [next] = remaining.splice(index < 0 ? 0 : index, 1)
    ids.delete(next.id)
    ordered.push(next)
  }
  return ordered
}

function orderedDeletions(bucket: Bucket, records: WireRecord[]): WireRecord[] {
  const remaining = records.filter((record) => record && typeof record.id === 'string')
  const ordered: WireRecord[] = []
  while (remaining.length) {
    const index = remaining.findIndex((record) => !remaining.some((other) => other !== record && dependencies(bucket, other).includes(record.id)))
    const [next] = remaining.splice(index < 0 ? remaining.length - 1 : index, 1)
    ordered.push(next)
  }
  return ordered
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

    for (const bucket of buckets) for (const record of orderedRecords(bucket, body[bucket] ?? [])) {
      const data = clean(bucket, record)
      await modelFor(bucket).upsert({ where: { id: record.id }, create: data, update: data })
    }
    for (const bucket of [...buckets].reverse()) {
      const records = (body[bucket] ?? []).filter((record) => record?.deleted && typeof record.id === 'string')
      for (const record of orderedDeletions(bucket, records)) await modelFor(bucket).deleteMany({ where: { id: record.id } })
    }
    return { ...(await snapshot()), updatedAt: new Date().toISOString() }
  })
}
