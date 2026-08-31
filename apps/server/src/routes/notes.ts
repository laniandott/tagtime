import type { FastifyInstance } from 'fastify'
import { unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import prisma from '../db.js'
import {
  atomicWriteFile,
  readNoteFile,
  syncNoteFileLocked,
  withNoteLock,
  removeNoteLocked,
  titleToFilename,
  noteAbsPath,
  notesEmitter,
  rewriteNoteTitleInOthers,
  suspendWatcherPaths,
} from '../notes.js'
import { normalizeTitleKey } from '../links.js'
import { getLocalGraph, getGlobalGraph } from '../notes-graph.js'
import { getRelatedEntities, getNotesByEntity } from '../notes-entities.js'

export type NoteListQuery = {
  q?: string
}

export default async function noteRoutes(app: FastifyInstance) {
  // API 重命名期间暂停 watcher 处理新旧路径：窗口需覆盖 watcher 的 500ms 防抖 + awaitWriteFinish(400ms) + 余量，
  // 保证重命名产生的 add/unlink 事件在数据库完成 path 更新前不会触发 watcher 建重复索引或误删旧索引。
  const RENAME_SUSPEND_MS = 3000
  // WebSocket 实时广播：Note created/updated/deleted/renamed
  app.get('/ws', { websocket: true }, (socket, _req) => {
    const send = (payload: unknown) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(payload))
    }
    const created = (p: unknown) => send({ type: 'note.created', ...(p as object) })
    const updated = (p: unknown) => send({ type: 'note.updated', ...(p as object) })
    const deleted = (p: unknown) => send({ type: 'note.deleted', ...(p as object) })
    const renamed = (p: unknown) => send({ type: 'note.renamed', ...(p as object) })
    notesEmitter.on('note.created', created)
    notesEmitter.on('note.updated', updated)
    notesEmitter.on('note.deleted', deleted)
    notesEmitter.on('note.renamed', renamed)
    socket.on('close', () => {
      notesEmitter.off('note.created', created)
      notesEmitter.off('note.updated', updated)
      notesEmitter.off('note.deleted', deleted)
      notesEmitter.off('note.renamed', renamed)
    })
  })

  // 列表：支持 ?q= 按标题/路径过滤
  app.get('/', async (req) => {
    const { q } = req.query as NoteListQuery
    const where = q
      ? {
          OR: [
            { title: { contains: q } },
            { path: { contains: q } },
          ],
        }
      : {}
    const notes = await prisma.note.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        path: true,
        title: true,
        revision: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { outLinks: true, inLinks: true } },
      },
    })
    return notes.map((n) => ({
      id: n.id,
      path: n.path,
      title: n.title,
      revision: n.revision,
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
      outLinkCount: n._count.outLinks,
      inLinkCount: n._count.inLinks,
    }))
  })

  // 输入补全候选
  app.get('/autocomplete', async (req) => {
    const { q } = req.query as NoteListQuery
    const where = q
      ? { OR: [{ title: { contains: q } }, { path: { contains: q } }] }
      : {}
    const notes = await prisma.note.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take: 20,
      select: { id: true, title: true, path: true },
    })
    return notes
  })

  // 全局关系图（必须置于 /:id 之前，避免被单段通配吞掉）
  app.get('/graph', async (req) => {
    const { q, dir, recent, limit } = req.query as {
      q?: string; dir?: string; recent?: string; limit?: string
    }
    const data = await getGlobalGraph({
      q,
      dir,
      recentDays: recent ? Number(recent) : undefined,
      limit: limit ? Number(limit) : undefined,
    })
    return data
  })

  // 反查：挂靠到某个 TagTime 实体（tag/todo/date/memo）的笔记
  app.get('/linked', async (req, reply) => {
    const { type, key } = req.query as { type?: string; key?: string }
    if (!type || !key) return reply.code(400).send({ error: '需要 type 和 key' })
    return getNotesByEntity(type as 'tag' | 'todo' | 'date' | 'memo', key)
  })

  // 单个笔记：正文 + 出入链
  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const note = await prisma.note.findUnique({
      where: { id },
      include: {
        outLinks: { orderBy: { createdAt: 'asc' } },
        inLinks: {
          include: { source: { select: { id: true, title: true, path: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    })
    if (!note) return reply.code(404).send({ error: '笔记不存在' })
    const content = await readNoteFile(note.path).catch(() => '')
    return {
      id: note.id,
      path: note.path,
      title: note.title,
      revision: note.revision,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      content,
      outLinks: note.outLinks.map((l) => ({
        id: l.id, targetNoteId: l.targetNoteId, targetTitle: l.targetTitle,
        linkText: l.linkText, isResolved: l.isResolved,
      })),
      inLinks: note.inLinks.map((l) => ({
        sourceNoteId: l.sourceNoteId, sourceTitle: l.source?.title ?? '', isResolved: l.isResolved,
      })),
    }
  })

  // 原始 Markdown
  app.get('/:id/raw', async (req, reply) => {
    const { id } = req.params as { id: string }
    const note = await prisma.note.findUnique({ where: { id } })
    if (!note) return reply.code(404).send({ error: '笔记不存在' })
    reply.type('text/markdown; charset=utf-8')
    return readNoteFile(note.path)
  })

  // 局部关系图：以当前笔记为中心，depth 默认 1
  app.get('/:id/graph', async (req, reply) => {
    const { id } = req.params as { id: string }
    const depth = Number((req.query as { depth?: string }).depth ?? 1) || 1
    const data = await getLocalGraph(id, depth)
    if (!data) return reply.code(404).send({ error: '笔记不存在' })
    return data
  })

  // 关联的 TagTime 实体（tag/todo/date/memo）
  app.get('/:id/entities', async (req, reply) => {
    const { id } = req.params as { id: string }
    const note = await prisma.note.findUnique({ where: { id } })
    if (!note) return reply.code(404).send({ error: '笔记不存在' })
    return getRelatedEntities(id)
  })

  // 新建笔记（创建带全局串行锁：查重→生成文件名→写文件→同步索引 整体原子化）
  app.post('/', async (req, reply) => {
    const { title, content } = req.body as { title?: string; content?: string }
    if (!title || !title.trim()) return reply.code(400).send({ error: '需要标题' })

    return withNoteLock('__create', async () => {
      let pathName = titleToFilename(title)
      let relPath = `${pathName}.md`
      let n = 2
      while (existsSync(noteAbsPath(relPath))) {
        relPath = `${pathName}-${n}.md`
        n++
      }

      const titleKey = normalizeTitleKey(title)
      const dup = await prisma.note.findUnique({ where: { titleKey } })
      if (dup) return reply.code(409).send({ error: '存在同名笔记（标题唯一）' })

      await atomicWriteFile(noteAbsPath(relPath), content ?? '')
      await syncNoteFileLocked(relPath, 'api')
      const note = await prisma.note.findUnique({ where: { path: relPath } })
      return reply.code(201).send({ id: note?.id, path: relPath, revision: note?.revision ?? 0 })
    })
  })

  // 更新内容（带 revision 冲突校验；读校验+写文件+同步索引 串行化，杜绝并发静默覆盖）
  app.put('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { content, revision } = req.body as { content?: string; revision?: number }
    if (typeof content !== 'string' || typeof revision !== 'number') {
      return reply.code(400).send({ error: '需要 content 和 revision' })
    }
    const note = await prisma.note.findUnique({ where: { id } })
    if (!note) return reply.code(404).send({ error: '笔记不存在' })

    return withNoteLock(note.path, async () => {
      const fresh = await prisma.note.findUnique({ where: { id } })
      if (!fresh) return reply.code(404).send({ error: '笔记不存在' })
      if (revision !== fresh.revision) {
        return reply.code(409).send({ error: '版本冲突：服务器已更新', serverRevision: fresh.revision })
      }
      await atomicWriteFile(noteAbsPath(fresh.path), content)
      await syncNoteFileLocked(fresh.path, 'api')
      const updated = await prisma.note.findUnique({ where: { id } })
      return reply.send({ id, path: fresh.path, revision: updated?.revision ?? fresh.revision })
    })
  })

  // 重命名（应用内重命名，保留 Note ID）
  // 锁策略：先取全局 __rename 锁（串行化所有重命名，跨笔记互相链接时不会 A 等 B、B 等 A），
  // 再取该笔记当前路径锁（与针对它的 PUT/DELETE 互斥）；锁内重新读取最新记录。
  app.patch('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { title } = req.body as { title?: string }
    if (!title || !title.trim()) return reply.code(400).send({ error: '需要标题' })
    const note = await prisma.note.findUnique({ where: { id } })
    if (!note) return reply.code(404).send({ error: '笔记不存在' })

    return withNoteLock('__rename', async () => {
      const fresh = await prisma.note.findUnique({ where: { id } })
      if (!fresh) return reply.code(404).send({ error: '笔记不存在' })
      return withNoteLock(fresh.path, async () => {
        const cur = await prisma.note.findUnique({ where: { id } })
        if (!cur) return reply.code(404).send({ error: '笔记不存在' })

        const newTitle = title.trim()
        const newKey = normalizeTitleKey(newTitle)
        const dup = await prisma.note.findMany({
          where: { titleKey: newKey, id: { not: id } },
          select: { id: true },
        })
        if (dup.length) return reply.code(409).send({ error: '存在同名笔记（标题唯一）' })

        const newBase = titleToFilename(newTitle)
        const newPath = `${newBase}.md`
        if (newPath !== cur.path && existsSync(noteAbsPath(newPath))) {
          return reply.code(409).send({ error: '目标文件名已存在' })
        }
        if (newPath !== cur.path) {
          suspendWatcherPaths([cur.path, newPath], RENAME_SUSPEND_MS)
          await atomicWriteFile(noteAbsPath(newPath), await readNoteFile(cur.path))
          await unlink(noteAbsPath(cur.path)).catch(() => {})
        }
        await prisma.note.update({
          where: { id },
          data: { path: newPath, title: newTitle, titleKey: newKey },
        })
        await syncNoteFileLocked(newPath, 'api')
        // 改写其它笔记正文里指向旧标题的 [[旧标题]]/[[旧标题|别名]] 并重建索引。
        // 已在全局 __rename 锁内，且被重命名笔记自身通过 skipPath 跳过（避免与上方路径锁重复加锁）。
        const renamedOwn = cur.title
        const rewritten = newKey !== normalizeTitleKey(renamedOwn)
          ? await rewriteNoteTitleInOthers(renamedOwn, newTitle, newPath)
          : 0
        notesEmitter.emit('note.renamed', { id, path: newPath, rewritten })
        return reply.send({ id, path: newPath, title: newTitle, rewritten })
      })
    })
  })

  // 删除（与 watcher 共用同一把 per-path 锁：先删文件，再删索引；watcher 后续事件会因同锁幂等跳过）
  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const note = await prisma.note.findUnique({ where: { id } })
    if (!note) return reply.code(404).send({ error: '笔记不存在' })

    return withNoteLock(note.path, async () => {
      await unlink(noteAbsPath(note.path)).catch(() => {})
      await removeNoteLocked(note.path)
      return reply.send({ ok: true })
    })
  })
}