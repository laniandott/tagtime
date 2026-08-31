import type { FastifyInstance } from 'fastify'
import { join } from 'node:path'
import { unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import prisma from '../db.js'
import { NOTES_DIR } from '../config.js'
import {
  atomicWriteFile,
  readNoteFile,
  syncNoteFile,
  titleToFilename,
  notesEmitter,
} from '../notes.js'
import { normalizeTitleKey } from '../links.js'
import { getLocalGraph, getGlobalGraph } from '../notes-graph.js'
import { getRelatedEntities, getNotesByEntity } from '../notes-entities.js'

export type NoteListQuery = {
  q?: string
}

export default async function noteRoutes(app: FastifyInstance) {
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

  // 新建笔记
  app.post('/', async (req, reply) => {
    const { title, content } = req.body as { title?: string; content?: string }
    if (!title || !title.trim()) return reply.code(400).send({ error: '需要标题' })

    let pathName = titleToFilename(title)
    let relPath = `${pathName}.md`
    let n = 2
    while (existsSync(join(NOTES_DIR, relPath))) {
      relPath = `${pathName}-${n}.md`
      n++
    }

    const titleKey = normalizeTitleKey(title)
    const dup = await prisma.note.findUnique({ where: { titleKey } })
    if (dup) return reply.code(409).send({ error: '存在同名笔记（标题唯一）' })

    await atomicWriteFile(join(NOTES_DIR, relPath), content ?? '')
    const synced = await syncNoteFile(relPath, 'api')
    const note = await prisma.note.findUnique({ where: { path: relPath } })
    return reply.code(201).send({ id: note?.id, path: relPath, revision: note?.revision ?? 0 })
  })

  // 更新内容（带 revision 冲突校验）
  app.put('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { content, revision } = req.body as { content?: string; revision?: number }
    if (typeof content !== 'string' || typeof revision !== 'number') {
      return reply.code(400).send({ error: '需要 content 和 revision' })
    }
    const note = await prisma.note.findUnique({ where: { id } })
    if (!note) return reply.code(404).send({ error: '笔记不存在' })
    if (revision !== note.revision) {
      return reply.code(409).send({
        error: '版本冲突：服务器已更新',
        serverRevision: note.revision,
      })
    }

    await atomicWriteFile(join(NOTES_DIR, note.path), content)
    const synced = await syncNoteFile(note.path, 'api')
    const updated = await prisma.note.findUnique({ where: { id } })
    return { id, path: note.path, revision: updated?.revision ?? note.revision }
  })

  // 重命名（应用内重命名，保留 Note ID）
  app.patch('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { title } = req.body as { title?: string }
    if (!title || !title.trim()) return reply.code(400).send({ error: '需要标题' })
    const note = await prisma.note.findUnique({ where: { id } })
    if (!note) return reply.code(404).send({ error: '笔记不存在' })

    const newKey = normalizeTitleKey(title)
    const dup = await prisma.note.findMany({
      where: { titleKey: newKey, id: { not: id } },
      select: { id: true },
    })
    if (dup.length) return reply.code(409).send({ error: '存在同名笔记（标题唯一）' })

    const newBase = titleToFilename(title)
    const newPath = `${newBase}.md`
    if (newPath !== note.path && existsSync(join(NOTES_DIR, newPath))) {
      return reply.code(409).send({ error: '目标文件名已存在' })
    }
    if (newPath !== note.path) {
      await atomicWriteFile(join(NOTES_DIR, newPath), await readNoteFile(note.path))
      await unlink(join(NOTES_DIR, note.path)).catch(() => {})
    }
    await prisma.note.update({
      where: { id },
      data: { path: newPath, title: title.trim(), titleKey: newKey },
    })
    await syncNoteFile(newPath, 'api')
    notesEmitter.emit('note.renamed', { id, path: newPath })
    return { id, path: newPath, title: title.trim() }
  })

  // 删除
  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const note = await prisma.note.findUnique({ where: { id } })
    if (!note) return reply.code(404).send({ error: '笔记不存在' })
    await unlink(join(NOTES_DIR, note.path)).catch(() => {})
    // 删除前先把指向该笔记的入链置为未解析（targetNoteId 由级联置空）
    await prisma.noteLink.updateMany({
      where: { targetNoteId: id },
      data: { isResolved: false, targetNoteId: null },
    })
    await prisma.note.delete({ where: { id } })
    notesEmitter.emit('note.deleted', { id, path: note.path })
    return { ok: true }
  })
}