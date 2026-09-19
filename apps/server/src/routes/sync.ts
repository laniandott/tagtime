import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'
import { activityDueDate } from '../activity-rules.js'

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

function modelFor(db: any, bucket: Bucket): any {
  const name = bucket === 'categories' ? 'category' : bucket === 'timeEntries' ? 'timeEntry' : bucket.slice(0, -1)
  return db[name]
}

function clean(bucket: Bucket, record: WireRecord): Record<string, unknown> {
  return Object.fromEntries(writable[bucket]
    .concat(['updatedAt'])
    .filter((key, index, all) => all.indexOf(key) === index && key in record)
    .map((key) => [key, record[key]]))
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value
  if (typeof value !== 'string') return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

function hasMutationTime(record: Record<string, unknown>): boolean {
  return ['updatedAt', 'createdAt', 'endTime', 'startTime'].some((key) => asDate(record[key]) !== null)
}

function mutationTime(record: Record<string, unknown>): Date {
  for (const key of ['updatedAt', 'createdAt', 'endTime', 'startTime']) {
    const date = asDate(record[key])
    if (date) return date
  }
  // Legacy clients did not send mutation timestamps; keep their old sync behavior.
  return new Date()
}

function storedTime(record: Record<string, unknown>): Date {
  return mutationTime(record)
}

async function syncMemoAttachments(tx: any, record: WireRecord): Promise<void> {
  if (!Array.isArray(record.attachments)) return
  const attachments = record.attachments.map((item) => {
    const value = item as Record<string, unknown>
    if (typeof value.filename !== 'string' || typeof value.path !== 'string' || !value.path.startsWith('/uploads/') || typeof value.mimeType !== 'string' || !Number.isInteger(value.size) || (value.size as number) < 0) {
      throw new Error('附件元数据无效')
    }
    return { memoId: record.id, filename: value.filename, path: value.path, mimeType: value.mimeType, size: value.size as number }
  })
  await tx.attachment.deleteMany({ where: { memoId: record.id } })
  if (attachments.length) await tx.attachment.createMany({ data: attachments })
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

async function reconcileActivityTodos(tx: any): Promise<void> {
  const goals = await tx.goal.findMany({
    where: { kind: 'activity', active: true },
    include: { tag: { select: { categoryId: true } } },
  })
  for (const goal of goals) {
    const dueDate = activityDueDate(goal)
    if (!dueDate) continue
    const data = {
      title: goal.title,
      priority: 0,
      dueDate,
      categoryId: goal.tag.categoryId,
      tagId: goal.tagId,
      goalId: goal.id,
      repeatType: goal.period,
    }
    const existing = await tx.todo.findFirst({ where: { goalId: goal.id, dueDate } })
    if (existing) {
      if (existing.status === 'pending') await tx.todo.update({ where: { id: existing.id }, data })
    } else if (dueDate >= new Date(Date.now() - 24 * 60 * 60 * 1000)) {
      await tx.todo.create({ data })
    }
  }
}

async function reconcileCompletedTodos(tx: any): Promise<void> {
  const completed = await tx.todo.findMany({ where: { status: 'done', completedAt: { not: null } } })
  for (const todo of completed) {
    const completedAt = todo.completedAt as Date
    if (todo.tagId) {
      const activityTag = await tx.tag.findUnique({ where: { id: todo.tagId }, select: { parentId: true } })
      if (activityTag?.parentId) {
        const entry = await tx.timeEntry.findFirst({
          where: {
            tagId: activityTag.parentId,
            dismissed: false,
            startTime: { lte: completedAt },
            OR: [{ endTime: null }, { endTime: { gte: completedAt } }],
          },
          orderBy: { startTime: 'desc' },
        })
        if (entry) {
          const memo = await tx.memo.findFirst({ where: { type: 'point', content: todo.title, timeEntryId: entry.id, createdAt: completedAt } })
          if (!memo) await tx.memo.create({ data: { content: todo.title, type: 'point', timeEntryId: entry.id, tagId: activityTag.parentId, createdAt: completedAt } })
        }
      }
    }
    if (!todo.goalId || !todo.dueDate) continue
    const goal = await tx.goal.findUnique({
      where: { id: todo.goalId },
      select: { id: true, title: true, tagId: true, kind: true, active: true, period: true, deadlineTime: true, deadlineDay: true, deadlineAt: true },
    })
    if (!goal?.active || goal.kind !== 'activity') continue
    const nextDueDate = activityDueDate(goal, todo.dueDate, 1)
    if (!nextDueDate) continue
    const next = await tx.todo.findFirst({ where: { goalId: goal.id, dueDate: nextDueDate } })
    if (!next) await tx.todo.create({
      data: {
        title: goal.title,
        description: todo.description,
        priority: todo.priority,
        dueDate: nextDueDate,
        categoryId: todo.categoryId,
        tagId: todo.tagId,
        goalId: goal.id,
        repeatType: goal.period,
      },
    })
  }
}

export default async function syncRoutes(app: FastifyInstance) {
  app.get('/', async () => ({ ...(await snapshot()), updatedAt: new Date().toISOString() }))
  app.post('/', async (req, reply) => {
    const body = (req.body ?? {}) as SyncBody
    if (typeof body.cursor !== 'number' || !Number.isFinite(body.cursor) || body.cursor < 0) return reply.code(400).send({ error: 'cursor 必须是有效的数字' })
    for (const bucket of buckets) if (body[bucket] !== undefined && !Array.isArray(body[bucket])) return reply.code(400).send({ error: `${bucket} 必须是数组` })

    await prisma.$transaction(async (tx) => {
      for (const bucket of buckets) for (const record of orderedRecords(bucket, body[bucket] ?? [])) {
        const data = clean(bucket, record)
        const incomingAt = mutationTime(record)
        const existing = await modelFor(tx, bucket).findUnique({ where: { id: record.id } })
        const tombstone = await tx.syncTombstone.findUnique({ where: { bucket_recordId: { bucket, recordId: record.id } } })
        if (hasMutationTime(record) && ((existing && storedTime(existing) > incomingAt) || (tombstone && tombstone.deletedAt > incomingAt))) continue
        await modelFor(tx, bucket).upsert({ where: { id: record.id }, create: data, update: data })
        if (bucket === 'memos') await syncMemoAttachments(tx, record)
        if (tombstone) await tx.syncTombstone.delete({ where: { id: tombstone.id } })
      }
      for (const bucket of [...buckets].reverse()) {
        const records = (body[bucket] ?? []).filter((record) => record?.deleted && typeof record.id === 'string')
        for (const record of orderedDeletions(bucket, records)) {
          const incomingAt = mutationTime(record)
          const existing = await modelFor(tx, bucket).findUnique({ where: { id: record.id } })
          const tombstone = await tx.syncTombstone.findUnique({ where: { bucket_recordId: { bucket, recordId: record.id } } })
          if (hasMutationTime(record) && ((existing && storedTime(existing) > incomingAt) || (tombstone && tombstone.deletedAt >= incomingAt))) continue
          await modelFor(tx, bucket).deleteMany({ where: { id: record.id } })
          await tx.syncTombstone.upsert({
            where: { bucket_recordId: { bucket, recordId: record.id } },
            create: { bucket, recordId: record.id, deletedAt: incomingAt },
            update: { deletedAt: incomingAt },
          })
        }
      }
      await reconcileActivityTodos(tx)
      await reconcileCompletedTodos(tx)
    })
    return { ...(await snapshot()), updatedAt: new Date().toISOString() }
  })
}
