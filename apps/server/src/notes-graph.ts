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
  linksTruncated?: boolean
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
  const nodes = new Map<string, GraphNode>()
  const links = new Map<string, GraphLink>()
  nodes.set(start.id, {
    id: start.id, title: start.title, path: start.path, isCurrent: true, level: 0,
  })

  // 只查询当前 BFS 边界的关系，不再把整个笔记库和全部链接一次性读进内存。
  // 对大型库来说，局部图请求的成本因此与 depth 范围内的邻居数量相关。
  let frontier = new Set([start.id])
  let linksTruncated = false
  const MAX_LOCAL_LINKS_PER_LEVEL = 5000
  for (let level = 0; level < depthLimit && frontier.size > 0; level++) {
    const boundary = [...frontier]
    const relationRows = await prisma.noteLink.findMany({
      where: {
        OR: [
          { sourceNoteId: { in: boundary } },
          { targetNoteId: { in: boundary } },
        ],
      },
      select: { sourceNoteId: true, targetNoteId: true, targetTitle: true, targetKey: true },
      orderBy: { createdAt: 'asc' },
      take: MAX_LOCAL_LINKS_PER_LEVEL + 1,
    })
    if (relationRows.length > MAX_LOCAL_LINKS_PER_LEVEL) {
      linksTruncated = true
      relationRows.length = MAX_LOCAL_LINKS_PER_LEVEL
    }

    const neighborIds = new Set<string>()
    for (const row of relationRows) {
      if (row.targetNoteId && !nodes.has(row.targetNoteId)) neighborIds.add(row.targetNoteId)
      if (!nodes.has(row.sourceNoteId)) neighborIds.add(row.sourceNoteId)
    }
    const neighbors = neighborIds.size > 0
      ? await prisma.note.findMany({
          where: { id: { in: [...neighborIds] } },
          select: { id: true, title: true, path: true },
        })
      : []
    const byId = new Map(neighbors.map((n) => [n.id, n]))
    const nextFrontier = new Set<string>()

    for (const l of relationRows) {
      const sourceIsCurrent = frontier.has(l.sourceNoteId)
      const targetIsCurrent = Boolean(l.targetNoteId && frontier.has(l.targetNoteId))
      if (sourceIsCurrent) {
        if (l.targetNoteId) {
          const n = byId.get(l.targetNoteId)
          if (n && !nodes.has(n.id)) {
            nodes.set(n.id, { id: n.id, title: n.title, path: n.path, level: level + 1 })
            if (level + 1 < depthLimit) nextFrontier.add(n.id)
          }
          links.set(`${l.sourceNoteId}->${l.targetNoteId}`, { source: l.sourceNoteId, target: l.targetNoteId, resolved: true })
        } else {
          const key = `_unresolved_${l.targetKey}`
          if (!nodes.has(key)) nodes.set(key, { id: key, title: l.targetTitle, path: null, isUnresolved: true, level: level + 1 })
          links.set(`${l.sourceNoteId}->${key}`, { source: l.sourceNoteId, target: key, resolved: false })
        }
      }
      if (targetIsCurrent && l.targetNoteId) {
        const n = byId.get(l.sourceNoteId)
        if (n && !nodes.has(n.id)) {
          nodes.set(n.id, { id: n.id, title: n.title, path: n.path, level: level + 1 })
          if (level + 1 < depthLimit) nextFrontier.add(n.id)
        }
        links.set(`${l.sourceNoteId}->${l.targetNoteId}`, { source: l.sourceNoteId, target: l.targetNoteId, resolved: true })
      }
    }
    frontier = nextFrontier
  }

  return { root: start.id, nodes: [...nodes.values()], links: [...links.values()], linksTruncated }
}

// 全局图：带 q/dir/recent 筛选，必须设置节点上限
export async function getGlobalGraph(filter: GlobalGraphFilter): Promise<GraphData> {
  const requestedLimit = Number(filter.limit ?? 200)
  const maxNodes = Number.isInteger(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), 500)
    : 200
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
  if (Number.isFinite(filter.recentDays) && (filter.recentDays ?? 0) > 0) {
    where.updatedAt = { gte: new Date(Date.now() - (filter.recentDays as number) * 864e5) }
  }

  const notes = await prisma.note.findMany({ where, orderBy: { updatedAt: 'desc' }, take: maxNodes + 1 })
  const truncated = notes.length > maxNodes
  const keep = notes.slice(0, maxNodes)
  const ids = new Set(keep.map((n) => n.id))

  const MAX_GLOBAL_LINKS = 10000
  const links = await prisma.noteLink.findMany({
    where: { sourceNoteId: { in: [...ids] } },
    select: { sourceNoteId: true, targetNoteId: true, targetTitle: true, targetKey: true },
    orderBy: { createdAt: 'asc' },
    take: MAX_GLOBAL_LINKS + 1,
  })
  const linksTruncated = links.length > MAX_GLOBAL_LINKS
  if (linksTruncated) links.length = MAX_GLOBAL_LINKS

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
    linksTruncated,
  }
}
