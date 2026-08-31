import { readFile } from 'node:fs/promises'
import prisma from './db.js'
import { parseEntityLinks, type EntityLinkType } from './links.js'
import { noteAbsPath } from './notes.js'

// 重建某笔记的 TagTime 实体关联（先删后插，按 type+entityKey 去重）
export async function rebuildEntityLinksForNote(noteId: string): Promise<void> {
  const note = await prisma.note.findUnique({ where: { id: noteId } })
  if (!note) return
  const content = await readFile(noteAbsPath(note.path), 'utf8').catch(() => '')
  const links = parseEntityLinks(content)
  await prisma.noteEntityLink.deleteMany({ where: { noteId } })
  if (!links.length) return

  const seen = new Set<string>()
  for (const l of links) {
    const key = `${l.type}:${l.entityKey}`
    if (seen.has(key)) continue
    seen.add(key)
    await prisma.noteEntityLink.create({
      data: { noteId, type: l.type, entityKey: l.entityKey, linkText: l.linkText },
    })
  }
}

// 关联的计时记录信息（经 memo.timeEntry 间接关联，阶段五范围）：
// 笔记不直接建 [[timeEntry:]] 链接，而是通过 [[memo:<id>]] 带到 TimeEntry
export interface RelatedTimeEntry {
  id: string
  startTime: string
  endTime: string | null
  tagName: string | null
}

export interface RelatedEntity {
  type: EntityLinkType
  entityKey: string
  linkText: string
  resolved: boolean
  name?: string // 解析后的显示名
  timeEntry?: RelatedTimeEntry | null // 仅 memo 有：该日记挂靠的计时记录
  memoTag?: string | null // 仅 memo 有：该日记的标签
}

// 解析某笔记的关联实体：把 tag/todo/memo 对应到真实对象，date 恒解析
export async function getRelatedEntities(
  noteId: string,
): Promise<{ tags: RelatedEntity[]; todos: RelatedEntity[]; memos: RelatedEntity[]; dates: RelatedEntity[] }> {
  const links = await prisma.noteEntityLink.findMany({ where: { noteId } })

  const tagKeys = links.filter((l) => l.type === 'tag').map((l) => l.entityKey)
  const todoKeys = links.filter((l) => l.type === 'todo').map((l) => l.entityKey)
  const memoIds = links.filter((l) => l.type === 'memo').map((l) => l.entityKey)

  const [tags, todos, memos] = await Promise.all([
    tagKeys.length
      ? prisma.tag.findMany({ where: { name: { in: tagKeys } } })
      : Promise.resolve([]),
    todoKeys.length
      ? prisma.todo.findMany({ where: { title: { in: todoKeys } } })
      : Promise.resolve([]),
    memoIds.length
      ? prisma.memo.findMany({
          where: { id: { in: memoIds } },
          include: {
            tag: { select: { name: true } },
            timeEntry: {
              select: { id: true, startTime: true, endTime: true, tag: { select: { name: true } } },
            },
          },
        })
      : Promise.resolve([]),
  ])

  const tagByName = new Map(tags.map((t) => [t.name, t]))
  const todoByTitle = new Map(todos.map((t) => [t.title, t]))
  const memoById = new Map(memos.map((m) => [m.id, m]))

  const mapEntity = (l: { type: string; entityKey: string; linkText: string }): RelatedEntity => {
    if (l.type === 'tag') {
      const t = tagByName.get(l.entityKey)
      return { type: 'tag', entityKey: l.entityKey, linkText: l.linkText, resolved: !!t, name: t?.name }
    }
    if (l.type === 'todo') {
      const t = todoByTitle.get(l.entityKey)
      return { type: 'todo', entityKey: l.entityKey, linkText: l.linkText, resolved: !!t, name: t?.title }
    }
    if (l.type === 'memo') {
      const m = memoById.get(l.entityKey)
      return {
        type: 'memo',
        entityKey: l.entityKey,
        linkText: l.linkText,
        resolved: !!m,
        name: m ? m.content.slice(0, 40) : undefined,
        timeEntry: m?.timeEntry
          ? {
              id: m.timeEntry.id,
              startTime: m.timeEntry.startTime.toISOString(),
              endTime: m.timeEntry.endTime ? m.timeEntry.endTime.toISOString() : null,
              tagName: m.timeEntry.tag?.name ?? null,
            }
          : null,
        memoTag: m?.tag?.name ?? null,
      }
    }
    return { type: 'date', entityKey: l.entityKey, linkText: l.linkText, resolved: true, name: l.entityKey }
  }

  const out = {
    tags: [] as RelatedEntity[],
    todos: [] as RelatedEntity[],
    memos: [] as RelatedEntity[],
    dates: [] as RelatedEntity[],
  }
  const groupKey: Record<EntityLinkType, keyof typeof out> = {
    tag: 'tags',
    todo: 'todos',
    memo: 'memos',
    date: 'dates',
  }
  for (const l of links) {
    const e = mapEntity(l)
    out[groupKey[e.type]].push(e)
  }
  return out
}

// 反查：挂靠到某个 TagTime 实体（tag/todo/date/memo）的笔记，按更新时间倒序
export async function getNotesByEntity(
  type: EntityLinkType,
  entityKey: string,
  take = 50,
): Promise<Array<{ id: string; title: string; path: string; updatedAt: Date; revision: number }>> {
  const links = await prisma.noteEntityLink.findMany({
    where: { type, entityKey },
    take,
    orderBy: { createdAt: 'desc' },
    include: { note: { select: { id: true, title: true, path: true, updatedAt: true, revision: true } } },
  })
  return links.map((l) => l.note)
}