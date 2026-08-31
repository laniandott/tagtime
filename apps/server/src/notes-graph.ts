import prisma from './db.js'

export interface GraphNode {
  id: string
  title: string
  path: string | null
  isCurrent?: boolean
  isUnresolved?: boolean
  level?: number
}

export interface GraphLink {
  source: string
  target: string
  resolved: boolean
}

export interface GraphData {
  root: string | null
  nodes: GraphNode[]
  links: GraphLink[]
  truncated?: boolean
}

export interface GlobalGraphFilter {
  q?: string
  dir?: string
  recentDays?: number
  limit?: number
  includeUnresolved?: boolean
}

// 局部图：以某笔记为中心的 BFS，depth 最多取 2 层
export async function getLocalGraph(noteId: string, depth = 1): Promise<GraphData | null> {
  const start = await prisma.note.findUnique({ where: { id: noteId } })
  if (!start) return null

  const depthLimit = Math.min(Math.max(depth, 1), 2)
  const all = await prisma.note.findMany()
  const byId = new Map(all.map((n) => [n.id, n]))

  const nodes = new Map<string, GraphNode>()
  const links = new Map<string, GraphLink>()
  nodes.set(start.id, {
    id: start.id, title: start.title, path: start.path, isCurrent: true, level: 0,
  })

  const queue: { id: string; level: number }[] = [{ id: start.id, level: 0 }]
  while (queue.length) {
    const cur = queue.shift()!
    if (cur.level >= depthLimit) continue

    const outLinks = await prisma.noteLink.findMany({ where: { sourceNoteId: cur.id } })
    for (const l of outLinks) {
      if (l.targetNoteId) {
        if (!nodes.has(l.targetNoteId)) {
          const n = byId.get(l.targetNoteId)
          if (n) {
            nodes.set(n.id, { id: n.id, title: n.title, path: n.path, level: cur.level + 1 })
            if (cur.level + 1 < depthLimit) queue.push({ id: n.id, level: cur.level + 1 })
          }
        }
        links.set(`${cur.id}->${l.targetNoteId}`, { source: cur.id, target: l.targetNoteId, resolved: true })
      } else if (!links.has(`${cur.id}->_unresolved_${l.targetKey}`)) {
        const key = `_unresolved_${l.targetKey}`
        if (!nodes.has(key)) {
          nodes.set(key, { id: key, title: l.targetTitle, path: null, isUnresolved: true, level: cur.level + 1 })
        }
        links.set(`${cur.id}->${key}`, { source: cur.id, target: key, resolved: false })
      }
    }

    const inLinks = await prisma.noteLink.findMany({ where: { targetNoteId: cur.id } })
    for (const l of inLinks) {
      if (!nodes.has(l.sourceNoteId)) {
        const n = byId.get(l.sourceNoteId)
        if (n) {
          nodes.set(n.id, { id: n.id, title: n.title, path: n.path, level: cur.level + 1 })
          if (cur.level + 1 < depthLimit) queue.push({ id: n.id, level: cur.level + 1 })
        }
      }
      links.set(`${l.sourceNoteId}->${cur.id}`, { source: l.sourceNoteId, target: cur.id, resolved: true })
    }
  }

  return { root: start.id, nodes: [...nodes.values()], links: [...links.values()] }
}

// 全局图：带 q/dir/recent 筛选，必须设置节点上限
export async function getGlobalGraph(filter: GlobalGraphFilter): Promise<GraphData> {
  const maxNodes = Math.min(Math.max(Number(filter.limit ?? 200), 20), 500)
  const includeUnresolved = filter.includeUnresolved ?? true

  const where: Record<string, unknown> = {}
  if (filter.q) {
    where.OR = [
      { title: { contains: filter.q } },
      { path: { contains: filter.q } },
    ]
  }
  if (filter.dir) {
    where.path = { startsWith: filter.dir }
  }
  if (filter.recentDays && filter.recentDays > 0) {
    where.updatedAt = { gte: new Date(Date.now() - filter.recentDays * 864e5) }
  }

  const notes = await prisma.note.findMany({ where, orderBy: { updatedAt: 'desc' }, take: maxNodes + 1 })
  const truncated = notes.length > maxNodes
  const keep = notes.slice(0, maxNodes)
  const ids = new Set(keep.map((n) => n.id))

  const links = await prisma.noteLink.findMany({
    where: { sourceNoteId: { in: [...ids] } },
    select: { sourceNoteId: true, targetNoteId: true, targetTitle: true, targetKey: true },
  })

  const nodes: GraphNode[] = keep.map((n) => ({ id: n.id, title: n.title, path: n.path }))
  const edges: GraphLink[] = []
  const unresolvedBin = new Map<string, GraphNode>()

  for (const l of links) {
    if (l.targetNoteId && ids.has(l.targetNoteId)) {
      edges.push({ source: l.sourceNoteId, target: l.targetNoteId, resolved: true })
    } else if (includeUnresolved && !l.targetNoteId) {
      const key = `_unresolved_${l.targetKey}`
      if (!unresolvedBin.has(key)) {
        unresolvedBin.set(key, { id: key, title: l.targetTitle, path: null, isUnresolved: true })
      }
      edges.push({ source: l.sourceNoteId, target: key, resolved: false })
    }
  }

  return {
    root: null,
    nodes: [...nodes, ...unresolvedBin.values()],
    links: edges,
    truncated,
  }
}