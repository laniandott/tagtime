import type { FastifyInstance } from 'fastify'
import '@fastify/websocket'
import { unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { posix } from 'node:path'
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
  normalizeNoteFolder,
  ensureNoteFolder,
  listNoteFolders,
  removeEmptyNoteFolder,
  rebuildNotesIndex,
  withNotesEventsSuppressed,
} from '../notes.js'
import { normalizeTitleKey } from '../links.js'
import {
  CONTENT_LIMITS,
  getNotesDir,
  notesDirUsesEnvironment,
  setNotesDir,
  validateNotesDir,
} from '../config.js'
import { stopNotesDirectory, trackNotesDirectory } from '../notes-watcher.js'
import { getLocalGraph, getGlobalGraph } from '../notes-graph.js'
import { getRelatedEntities, getNotesByEntity } from '../notes-entities.js'
import { singleQueryString } from './query.js'

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
    const reindexed = (p: unknown) => send({ type: 'notes.reindexed', ...(p as object) })
    notesEmitter.on('note.created', created)
    notesEmitter.on('note.updated', updated)
    notesEmitter.on('note.deleted', deleted)
    notesEmitter.on('note.renamed', renamed)
    notesEmitter.on('notes.reindexed', reindexed)
    socket.on('close', () => {
      notesEmitter.off('note.created', created)
      notesEmitter.off('note.updated', updated)
      notesEmitter.off('note.deleted', deleted)
      notesEmitter.off('note.renamed', renamed)
      notesEmitter.off('notes.reindexed', reindexed)
    })
  })

  // 当前文件库位置。浏览器只提交本机绝对路径，由本地服务访问该目录。
  app.get('/vault', async () => ({
    path: getNotesDir(),
    source: notesDirUsesEnvironment() ? 'environment' : 'config',
    noteCount: await prisma.note.count(),
  }))

  // 切换文件库：只更换索引来源，不复制、移动或删除任何 Markdown 文件。
  app.post('/vault', async (req, reply) => {
    const { path } = (req.body ?? {}) as { path?: string }
    let nextPath: string
    try {
      nextPath = validateNotesDir(path ?? '')
    } catch (e: any) {
      return reply.code(400).send({ error: e.message })
    }

    const currentPath = getNotesDir()
    if (nextPath === currentPath) {
      return reply.send({
        path: currentPath,
        source: notesDirUsesEnvironment() ? 'environment' : 'config',
        noteCount: await prisma.note.count(),
      })
    }
    if (notesDirUsesEnvironment()) {
      return reply.code(409).send({ error: '当前由 NOTES_DIR 环境变量固定文件库路径' })
    }

    return withNoteLock('__vault', async () => {
      // 其它请求可能在排队期间已经完成一次切换，再检查一次实际路径。
      const activePath = getNotesDir()
      if (nextPath === activePath) {
        return reply.send({
          path: activePath,
          source: notesDirUsesEnvironment() ? 'environment' : 'config',
          noteCount: await prisma.note.count(),
        })
      }
      try {
        await stopNotesDirectory()
        setNotesDir(nextPath)
        await withNotesEventsSuppressed(() => rebuildNotesIndex())
        trackNotesDirectory()
        notesEmitter.emit('notes.reindexed', { path: nextPath })
        return reply.send({ path: nextPath, source: 'config', noteCount: await prisma.note.count() })
      } catch (error: any) {
        // 切换失败时尽力恢复原路径与索引；原目录中的 Markdown 从未被修改。
        try {
          setNotesDir(activePath)
          await withNotesEventsSuppressed(() => rebuildNotesIndex())
          trackNotesDirectory()
          notesEmitter.emit('notes.reindexed', { path: activePath })
        } catch (restoreError) {
          req.log.error(restoreError, '文件库切换失败且恢复索引失败')
        }
        req.log.error(error, '文件库切换失败')
        return reply.code(500).send({ error: '文件库切换失败，已尝试恢复原文件库' })
      }
    })
  })

  // 列表：支持 ?q= 按标题/路径过滤
  app.get('/', async (req, reply) => {
    const rawQ = (req.query as Record<string, unknown>).q
    const q = singleQueryString(rawQ)
    if (q === null) return reply.code(400).send({ error: 'q 必须是单个字符串' })
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
  app.get('/autocomplete', async (req, reply) => {
    const rawQ = (req.query as Record<string, unknown>).q
    const q = singleQueryString(rawQ)
    if (q === null) return reply.code(400).send({ error: 'q 必须是单个字符串' })
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

  // 文件夹管理：目录直接落在 NOTES_DIR 下，空字符串表示根目录。
  app.get('/folders', async () => ({ folders: await listNoteFolders() }))

  app.post('/folders', async (req, reply) => {
    const { path } = (req.body ?? {}) as { path?: string }
    if (typeof path !== 'string' || !path.trim()) return reply.code(400).send({ error: '需要文件夹路径' })
    try {
      const folder = normalizeNoteFolder(path)
      if (!folder) return reply.code(400).send({ error: '不能创建笔记根目录' })
      await ensureNoteFolder(folder)
      return reply.code(201).send({ path: folder })
    } catch (e: any) {
      return reply.code(400).send({ error: e.message })
    }
  })

  app.delete('/folders', async (req, reply) => {
    const path = singleQueryString((req.query as Record<string, unknown>).path)
    if (path === null) return reply.code(400).send({ error: 'path 必须是单个字符串' })
    if (typeof path !== 'string' || !path.trim()) return reply.code(400).send({ error: '需要文件夹路径' })
    try {
      await removeEmptyNoteFolder(path)
      return reply.send({ ok: true })
    } catch (e: any) {
      const status = e?.code === 'ENOTEMPTY' || e?.code === 'EEXIST' || /不为空/.test(e.message) ? 409 : 400
      return reply.code(status).send({ error: e.message })
    }
  })

  // 全局关系图（必须置于 /:id 之前，避免被单段通配吞掉）
  app.get('/graph', async (req, reply) => {
    const raw = req.query as Record<string, unknown>
    const q = singleQueryString(raw.q)
    const dir = singleQueryString(raw.dir)
    const recent = singleQueryString(raw.recent)
    const limit = singleQueryString(raw.limit)
    if (q === null || dir === null || recent === null || limit === null) {
      return reply.code(400).send({ error: '关系图查询参数必须是单个字符串' })
    }
    if (q && q.length > 200 || dir && dir.length > 1024) {
      return reply.code(400).send({ error: '关系图筛选条件过长' })
    }
    if (recent !== undefined) {
      const value = Number(recent)
      if (!Number.isInteger(value) || value < 0 || value > 3660) {
        return reply.code(400).send({ error: 'recent 必须是 0 到 3660 的整数' })
      }
    }
    if (limit !== undefined) {
      const value = Number(limit)
      if (!Number.isInteger(value) || value < 1 || value > 500) {
        return reply.code(400).send({ error: 'limit 必须是 1 到 500 的整数' })
      }
    }
    const data = await getGlobalGraph({
      q,
      dir,
      recentDays: recent && Number.isFinite(Number(recent)) ? Number(recent) : undefined,
      limit: limit && Number.isFinite(Number(limit)) ? Number(limit) : undefined,
    })
    return data
  })

  // 反查：挂靠到某个 TagTime 实体（tag/todo/date/memo）的笔记
  app.get('/linked', async (req, reply) => {
    const raw = req.query as Record<string, unknown>
    const type = singleQueryString(raw.type)
    const key = singleQueryString(raw.key)
    if (type === null || key === null) return reply.code(400).send({ error: 'type 和 key 必须是单个字符串' })
    if (!type || !key) return reply.code(400).send({ error: '需要 type 和 key' })
    if (!['tag', 'todo', 'date', 'memo'].includes(type)) return reply.code(400).send({ error: 'type 无效' })
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
    let content: string
    try {
      content = await readNoteFile(note.path)
    } catch (error) {
      req.log.error(error, `读取笔记失败: ${note.path}`)
      return reply.code(503).send({ error: '笔记文件暂时无法读取，请勿覆盖保存' })
    }
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
    try {
      return await readNoteFile(note.path)
    } catch (error) {
      req.log.error(error, `读取笔记失败: ${note.path}`)
      return reply.code(503).send({ error: '笔记文件暂时无法读取' })
    }
  })

  // 局部关系图：以当前笔记为中心，depth 默认 1
  app.get('/:id/graph', async (req, reply) => {
    const { id } = req.params as { id: string }
    const rawDepth = singleQueryString((req.query as Record<string, unknown>).depth)
    if (rawDepth === null) return reply.code(400).send({ error: 'depth 必须是单个字符串' })
    const depth = rawDepth === undefined ? 1 : Number(rawDepth)
    if (!Number.isInteger(depth) || depth < 1 || depth > 2) {
      return reply.code(400).send({ error: 'depth 必须是 1 或 2' })
    }
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
    const { title, content, folder = '' } = (req.body ?? {}) as { title?: string; content?: string; folder?: string }
    if (typeof title !== 'string' || !title.trim()) return reply.code(400).send({ error: '需要标题' })
    if (title.length > CONTENT_LIMITS.NOTE_TITLE) {
      return reply.code(400).send({ error: `标题不能超过 ${CONTENT_LIMITS.NOTE_TITLE} 个字符` })
    }
    if (content !== undefined && typeof content !== 'string') {
      return reply.code(400).send({ error: 'content 必须是字符串' })
    }
    if (typeof content === 'string' && content.length > CONTENT_LIMITS.NOTE_CONTENT) {
      return reply.code(400).send({ error: `内容不能超过 ${CONTENT_LIMITS.NOTE_CONTENT} 个字符` })
    }
    if (typeof folder !== 'string') return reply.code(400).send({ error: 'folder 必须是字符串' })

    return withNoteLock('__create', async () => {
      let safeFolder: string
      try {
        safeFolder = normalizeNoteFolder(folder)
        await ensureNoteFolder(safeFolder)
      } catch (e: any) {
        return reply.code(400).send({ error: e.message })
      }
      let pathName = titleToFilename(title)
      const inFolder = (name: string) => safeFolder ? `${safeFolder}/${name}` : name
      let relPath = inFolder(`${pathName}.md`)
      let n = 2
      while (existsSync(noteAbsPath(relPath))) {
        relPath = inFolder(`${pathName}-${n}.md`)
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
    const { content, revision } = (req.body ?? {}) as { content?: string; revision?: number }
    if (typeof content !== 'string' || !Number.isInteger(revision) || (revision as number) < 0) {
      return reply.code(400).send({ error: '需要 content 和 revision' })
    }
    if (content.length > CONTENT_LIMITS.NOTE_CONTENT) {
      return reply.code(400).send({ error: `内容不能超过 ${CONTENT_LIMITS.NOTE_CONTENT} 个字符` })
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
    const { title, folder } = (req.body ?? {}) as { title?: string; folder?: string }
    if (title !== undefined && (typeof title !== 'string' || !title.trim())) return reply.code(400).send({ error: '标题不能为空' })
    if (title !== undefined && title.length > CONTENT_LIMITS.NOTE_TITLE) {
      return reply.code(400).send({ error: `标题不能超过 ${CONTENT_LIMITS.NOTE_TITLE} 个字符` })
    }
    if (folder !== undefined && typeof folder !== 'string') return reply.code(400).send({ error: 'folder 必须是字符串' })
    if (title === undefined && folder === undefined) return reply.code(400).send({ error: '需要标题或文件夹' })
    const note = await prisma.note.findUnique({ where: { id } })
    if (!note) return reply.code(404).send({ error: '笔记不存在' })

    return withNoteLock('__rename', async () => {
      const fresh = await prisma.note.findUnique({ where: { id } })
      if (!fresh) return reply.code(404).send({ error: '笔记不存在' })
      return withNoteLock(fresh.path, async () => {
        const cur = await prisma.note.findUnique({ where: { id } })
        if (!cur) return reply.code(404).send({ error: '笔记不存在' })

        const newTitle = title?.trim() ?? cur.title
        const newKey = normalizeTitleKey(newTitle)
        const dup = await prisma.note.findMany({
          where: { titleKey: newKey, id: { not: id } },
          select: { id: true },
        })
        if (dup.length) return reply.code(409).send({ error: '存在同名笔记（标题唯一）' })

        let targetFolder: string
        try {
          const currentFolder = posix.dirname(cur.path) === '.' ? '' : posix.dirname(cur.path)
          targetFolder = folder === undefined ? currentFolder : normalizeNoteFolder(folder)
          await ensureNoteFolder(targetFolder)
        } catch (e: any) {
          return reply.code(400).send({ error: e.message })
        }

        const newBase = titleToFilename(newTitle)
        const newPath = targetFolder ? `${targetFolder}/${newBase}.md` : `${newBase}.md`
        if (newPath !== cur.path && existsSync(noteAbsPath(newPath))) {
          return reply.code(409).send({ error: '目标文件名已存在' })
        }
        if (newPath !== cur.path) {
          suspendWatcherPaths([cur.path, newPath], RENAME_SUSPEND_MS)
          await atomicWriteFile(noteAbsPath(newPath), await readNoteFile(cur.path))
          try {
            await unlink(noteAbsPath(cur.path))
          } catch (error) {
            await unlink(noteAbsPath(newPath)).catch(() => {})
            throw error
          }
        }
        const renamed = await prisma.note.update({
          where: { id },
          data: { path: newPath, title: newTitle, titleKey: newKey, revision: { increment: 1 } },
        })
        await syncNoteFileLocked(newPath, 'api')
        // 改写其它笔记正文里指向旧标题的 [[旧标题]]/[[旧标题|别名]] 并重建索引。
        // 已在全局 __rename 锁内，且被重命名笔记自身通过 skipPath 跳过（避免与上方路径锁重复加锁）。
        const renamedOwn = cur.title
        const rewritten = newKey !== normalizeTitleKey(renamedOwn)
          ? await rewriteNoteTitleInOthers(renamedOwn, newTitle, newPath)
          : 0
        notesEmitter.emit('note.renamed', { id, path: newPath, rewritten })
        return reply.send({ id, path: newPath, title: newTitle, revision: renamed.revision, rewritten })
      })
    })
  })

  // 删除（与 watcher 共用同一把 per-path 锁：先删文件，再删索引；watcher 后续事件会因同锁幂等跳过）
  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const note = await prisma.note.findUnique({ where: { id } })
    if (!note) return reply.code(404).send({ error: '笔记不存在' })

    return withNoteLock(note.path, async () => {
      try {
        await unlink(noteAbsPath(note.path))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          req.log.error(error, `删除笔记文件失败: ${note.path}`)
          return reply.code(500).send({ error: '笔记文件删除失败，索引已保留' })
        }
      }
      await removeNoteLocked(note.path)
      return reply.send({ ok: true })
    })
  })
}
