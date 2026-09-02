import type { FastifyInstance, FastifyReply } from 'fastify'
import { randomUUID } from 'node:crypto'
import { basename, resolve, sep } from 'node:path'
import { createWriteStream } from 'node:fs'
import { lstat, realpath, stat, unlink } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import prisma from '../db.js'
import { CONTENT_LIMITS, UPLOAD_DIR } from '../config.js'
import { singleQueryString } from './query.js'

export { UPLOAD_DIR }

type AttachmentInput = {
  filename: string
  path: string
  mimeType: string
  size: number
}

const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/bmp': 'bmp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-msvideo': 'avi',
  'video/mpeg': 'mpg',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
}
const MAX_ATTACHMENTS_PER_MEMO = 100

// Memo 的附件引用与磁盘清理必须串行化。否则一个请求在“查询引用数”和“删除文件”之间，
// 另一个请求可能刚好新增同一路径的引用，导致数据库仍有引用但文件已被删掉。
let memoMutationTail = Promise.resolve()

async function withMemoMutationLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = memoMutationTail
  let release!: () => void
  memoMutationTail = new Promise<void>((resolve) => { release = resolve })
  await previous
  try {
    return await operation()
  } finally {
    release()
  }
}

class ClientInputError extends Error {}
class MemoNotFoundError extends Error {}
const MEMO_TYPES = new Set(['point', 'diary'])

async function validateMemoReferences(
  timeEntryId: unknown,
  tagId: unknown,
  reply: FastifyReply,
): Promise<boolean> {
  for (const [value, field] of [[timeEntryId, 'timeEntryId'], [tagId, 'tagId']] as const) {
    if (value !== undefined && value !== null && typeof value !== 'string') {
      reply.code(400).send({ error: `${field} 必须是字符串` })
      return false
    }
  }
  const [timeEntry, tag] = await Promise.all([
    typeof timeEntryId === 'string' && timeEntryId
      ? prisma.timeEntry.findUnique({ where: { id: timeEntryId }, select: { id: true } })
      : null,
    typeof tagId === 'string' && tagId
      ? prisma.tag.findUnique({ where: { id: tagId }, select: { id: true } })
      : null,
  ])
  if (typeof timeEntryId === 'string' && timeEntryId && !timeEntry) {
    reply.code(404).send({ error: '关联计时记录不存在' })
    return false
  }
  if (typeof tagId === 'string' && tagId && !tag) {
    reply.code(404).send({ error: '关联标签不存在' })
    return false
  }
  return true
}

function safeUploadFile(uploadPath: string): { path: string; fileName: string; fullPath: string } {
  if (typeof uploadPath !== 'string' || !uploadPath.startsWith('/uploads/')) {
    throw new ClientInputError('附件路径无效')
  }
  if (uploadPath.length > 1024) throw new ClientInputError('附件路径过长')
  const fileName = uploadPath.slice('/uploads/'.length)
  if (!fileName || fileName !== basename(fileName) || fileName.includes('/') || fileName.includes('\\')) {
    throw new ClientInputError('附件路径无效')
  }
  const uploadRoot = resolve(UPLOAD_DIR)
  const fullPath = resolve(uploadRoot, fileName)
  if (!fullPath.startsWith(uploadRoot + sep)) throw new ClientInputError('附件路径越界')
  return { path: `/uploads/${fileName}`, fileName, fullPath }
}

async function normalizeAttachments(inputs: AttachmentInput[] | undefined): Promise<AttachmentInput[] | undefined> {
  if (inputs === undefined) return undefined
  if (!Array.isArray(inputs)) throw new ClientInputError('attachments 必须是数组')
  if (inputs.length > MAX_ATTACHMENTS_PER_MEMO) {
    throw new ClientInputError(`单条记事最多 ${MAX_ATTACHMENTS_PER_MEMO} 个附件`)
  }

  const seen = new Set<string>()
  const normalized: AttachmentInput[] = []
  for (const input of inputs) {
    if (!input || typeof input !== 'object') throw new ClientInputError('附件信息无效')
    const safe = safeUploadFile(input.path)
    if (seen.has(safe.path)) throw new ClientInputError('附件不能重复')
    seen.add(safe.path)

    let fileStat
    let entry
    try {
      entry = await lstat(safe.fullPath)
    } catch {
      throw new ClientInputError(`附件文件不存在: ${safe.fileName}`)
    }
    if (entry.isSymbolicLink()) throw new ClientInputError('不允许使用符号链接附件')
    try {
      fileStat = await stat(safe.fullPath)
    } catch {
      throw new ClientInputError(`附件文件不存在: ${safe.fileName}`)
    }
    if (!fileStat.isFile()) throw new ClientInputError('附件不是普通文件')

    // 即使最终目录项不是符号链接，中间目录也可能是指向 uploads 外部的链接。
    // 通过 realpath 再做一次根目录约束，避免把服务器任意文件挂进 Memo。
    let realUploadRoot: string
    let realFile: string
    try {
      ;[realUploadRoot, realFile] = await Promise.all([realpath(UPLOAD_DIR), realpath(safe.fullPath)])
    } catch {
      throw new ClientInputError(`附件文件不存在: ${safe.fileName}`)
    }
    if (!realFile.startsWith(realUploadRoot + sep)) {
      throw new ClientInputError('附件路径越界')
    }

    const originalName = typeof input.filename === 'string' ? basename(input.filename.trim()) : ''
    normalized.push({
      filename: (originalName || safe.fileName).slice(0, 255),
      path: safe.path,
      mimeType: typeof input.mimeType === 'string' ? input.mimeType.slice(0, 100) : 'application/octet-stream',
      size: fileStat.size,
    })
  }
  return normalized
}

async function removeUploadIfUnreferenced(uploadPath: string): Promise<void> {
  const safe = safeUploadFile(uploadPath)
  const references = await prisma.attachment.count({ where: { path: safe.path } })
  if (references > 0) return
  await unlink(safe.fullPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
}

async function cleanupAttachmentInputs(inputs: unknown): Promise<void> {
  if (!Array.isArray(inputs)) return
  for (const input of inputs) {
    const path = input && typeof input === 'object' && 'path' in input
      ? (input as { path?: unknown }).path
      : undefined
    if (typeof path !== 'string') continue
    try {
      await removeUploadIfUnreferenced(path)
    } catch {
      // 非法路径或清理失败不应覆盖原始请求错误；调用方会记录后继续处理。
    }
  }
}

function validDate(value: unknown, field: string): Date | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim()) throw new ClientInputError(`${field} 不是有效时间`)
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) throw new ClientInputError(`${field} 不是有效时间`)
  return parsed
}

export default async function memoRoutes(app: FastifyInstance) {
  // 1. 获取 Memos 列表（支持时间切片或绑定计时ID及类型筛选）
  app.get('/', async (req, reply) => {
    const raw = req.query as Record<string, unknown>
    const timeEntryId = singleQueryString(raw.timeEntryId)
    const tagId = singleQueryString(raw.tagId)
    const days = singleQueryString(raw.days)
    const from = singleQueryString(raw.from)
    const to = singleQueryString(raw.to)
    const standaloneOnly = singleQueryString(raw.standaloneOnly)
    const type = singleQueryString(raw.type)
    if (
      timeEntryId === null || tagId === null || days === null || from === null ||
      to === null || standaloneOnly === null || type === null
    ) {
      return reply.code(400).send({ error: '查询参数必须是单个字符串' })
    }
    if (standaloneOnly && !['true', '1', 'false', '0'].includes(standaloneOnly)) {
      return reply.code(400).send({ error: 'standaloneOnly 必须是 true 或 false' })
    }

    const where: Record<string, unknown> = {}
    if (timeEntryId) where.timeEntryId = timeEntryId
    if (tagId) where.tagId = tagId
    if (type && !MEMO_TYPES.has(type)) return reply.code(400).send({ error: 'type 只能是 point 或 diary' })
    if (type) (where as any).type = type
    if (standaloneOnly === 'true' || standaloneOnly === '1') {
      where.timeEntryId = null
    }

    const parsedFrom = from ? new Date(from) : null
    const parsedTo = to ? new Date(to) : null
    if ((parsedFrom && !Number.isFinite(parsedFrom.getTime())) || (parsedTo && !Number.isFinite(parsedTo.getTime()))) {
      return reply.code(400).send({ error: '时间范围无效' })
    }
    if (parsedFrom && parsedTo && parsedTo < parsedFrom) {
      return reply.code(400).send({ error: 'to 不能早于 from' })
    }

    if (from || to || days) {
      where.createdAt = {}
      if (from) {
        ;(where.createdAt as { gte?: Date }).gte = parsedFrom as Date
      } else if (days) {
        const dayCount = Number(days)
        if (!Number.isInteger(dayCount) || dayCount < 1 || dayCount > 3660) {
          return reply.code(400).send({ error: 'days 必须是 1 到 3660 的整数' })
        }
        const d = new Date()
        d.setDate(d.getDate() - (dayCount - 1))
        d.setHours(0, 0, 0, 0)
        ;(where.createdAt as { gte?: Date }).gte = d
      }

      if (to) {
        ;(where.createdAt as { lte?: Date }).lte = parsedTo as Date
      }
    }

    return prisma.memo.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        attachments: true,
        tag: { include: { category: true } },
        timeEntry: { include: { tag: { include: { category: true } } } },
      },
      take: 2000,
    })
  })

  // 2. 创建 Memo（支持自定义创建时间与类型 point/diary）
  app.post('/', async (req, reply) => withMemoMutationLock(async () => {
    const { content, timeEntryId, tagId, attachments, createdAt, type } = (req.body ?? {}) as {
      content: string
      timeEntryId?: string
      tagId?: string
      createdAt?: string
      type?: string
      attachments?: { filename: string; path: string; mimeType: string; size: number }[]
    }

    if (typeof content !== 'string' || !content.trim()) {
      reply.code(400)
      return { error: '内容不能为空' }
    }

    if (content.length > CONTENT_LIMITS.MEMO_CONTENT) {
      return reply.code(400).send({ error: `内容不能超过 ${CONTENT_LIMITS.MEMO_CONTENT} 个字符` })
    }

    if (type !== undefined && !MEMO_TYPES.has(type)) {
      return reply.code(400).send({ error: 'type 只能是 point 或 diary' })
    }
    if (!await validateMemoReferences(timeEntryId, tagId, reply)) return

    let safeAttachments: AttachmentInput[] | undefined
    try {
      safeAttachments = await normalizeAttachments(attachments)
      const created = await prisma.memo.create({
        data: {
          content: content.trim(),
          type: type || 'diary',
          timeEntryId: timeEntryId || null,
          tagId: tagId || null,
          createdAt: validDate(createdAt, 'createdAt'),
          attachments: safeAttachments ? { create: safeAttachments } : undefined,
        },
        include: {
          attachments: true,
          tag: { include: { category: true } },
          timeEntry: { include: { tag: { include: { category: true } } } },
        },
      })
      return created
    } catch (error) {
      // 文件上传与 Memo 写入是两个请求；若数据库写入失败，清理本次请求刚引用的
      // 未被其它 Memo 使用的文件，避免长期积累孤儿附件。
      if (safeAttachments) {
        for (const attachment of safeAttachments) {
          await removeUploadIfUnreferenced(attachment.path).catch((cleanupError) => {
            req.log.warn(cleanupError, `清理孤儿附件失败: ${attachment.path}`)
          })
        }
      } else {
        // normalizeAttachments 可能在处理数组中途失败；此时 safeAttachments 尚未赋值，
        // 仍需尽力清理本次请求里已上传但未入库的前置文件。
        await cleanupAttachmentInputs(attachments)
      }
      if (error instanceof ClientInputError) return reply.code(400).send({ error: error.message })
      throw error
    }
  }))

  // 3. 上传图片或视频接口
  app.post('/upload', async (req, reply) => {
    let filePath: string | undefined
    try {
      const data = await req.file()
      if (!data) {
        reply.code(400)
        return { error: '未检测到上传文件' }
      }

      const mimeType = (data.mimetype || '').toLowerCase()
      const ext = MIME_EXTENSIONS[mimeType]
      if (!ext) {
        data.file.resume()
        return reply.code(415).send({ error: '仅支持图片、视频或音频文件' })
      }
      const fileName = `${Date.now()}_${randomUUID().slice(0, 8)}.${ext}`
      filePath = safeUploadFile(`/uploads/${fileName}`).fullPath
      await pipeline(data.file, createWriteStream(filePath, { flags: 'wx' }))
      if (data.file.truncated) {
        await unlink(filePath).catch(() => {})
        return reply.code(413).send({ error: '文件超过上传大小限制' })
      }
      const fileStat = await stat(filePath)

      return {
        filename: (basename(data.filename || `file.${ext}`) || `file.${ext}`).slice(0, 255),
        path: `/uploads/${fileName}`,
        mimeType,
        size: fileStat.size,
      }
    } catch (err: any) {
      if (filePath) await unlink(filePath).catch(() => {})
      req.log.error(err)
      if (err?.code === 'FST_REQ_FILE_TOO_LARGE') {
        return reply.code(413).send({ error: '文件超过上传大小限制' })
      }
      return reply.code(500).send({ error: '上传文件失败，请稍后重试' })
    }
  })


  // 4. 编辑 Memo（内容、时间、附件增删）
  app.put('/:id', async (req, reply) => withMemoMutationLock(async () => {
    const { id } = req.params as { id: string }
    const { content, createdAt, attachments } = (req.body ?? {}) as {
      content?: string
      createdAt?: string
      attachments?: { filename: string; path: string; mimeType: string; size: number }[]
    }

    let safeAttachments: AttachmentInput[] | undefined
    try {
      if (content !== undefined && typeof content !== 'string') {
        throw new ClientInputError('content 必须是字符串')
      }
      if (typeof content === 'string' && !content.trim()) {
        throw new ClientInputError('内容不能为空')
      }
      if (typeof content === 'string' && content.length > CONTENT_LIMITS.MEMO_CONTENT) {
        throw new ClientInputError(`内容不能超过 ${CONTENT_LIMITS.MEMO_CONTENT} 个字符`)
      }
      safeAttachments = await normalizeAttachments(attachments)
      const createdAtDate = validDate(createdAt, 'createdAt')
      const { updated, removedPaths } = await prisma.$transaction(async (tx) => {
        const existing = await tx.memo.findUnique({ where: { id }, include: { attachments: true } })
        if (!existing) throw new MemoNotFoundError('记事不存在')

        const removedPaths: string[] = []
        if (safeAttachments !== undefined) {
          const incomingPaths = new Set(safeAttachments.map((attachment) => attachment.path))
          const existingPaths = new Set(existing.attachments.map((attachment) => attachment.path))
          const removed = existing.attachments.filter((attachment) => !incomingPaths.has(attachment.path))
          removedPaths.push(...removed.map((attachment) => attachment.path))
          if (removed.length > 0) {
            await tx.attachment.deleteMany({ where: { id: { in: removed.map((attachment) => attachment.id) } } })
          }

          const added = safeAttachments.filter((attachment) => !existingPaths.has(attachment.path))
          if (added.length > 0) {
            await tx.attachment.createMany({
              data: added.map((attachment) => ({ memoId: id, ...attachment })),
            })
          }
        }

        const updated = await tx.memo.update({
          where: { id },
          data: {
            ...(content !== undefined ? { content: content.trim() } : {}),
            ...(createdAtDate !== undefined ? { createdAt: createdAtDate } : {}),
          },
          include: {
            attachments: true,
            tag: { include: { category: true } },
            timeEntry: { include: { tag: { include: { category: true } } } },
          },
        })
        return { updated, removedPaths }
      })

      for (const path of removedPaths) {
        await removeUploadIfUnreferenced(path).catch((error) => req.log.warn(error, `清理附件失败: ${path}`))
      }
      return updated
    } catch (error) {
      // 编辑请求也可能先完成附件校验/上传、随后在事务或时间校验阶段失败；
      // 此时清理本次请求新引用且尚未被其它 Memo 使用的文件，避免孤儿附件。
      if (safeAttachments) {
        for (const attachment of safeAttachments) {
          await removeUploadIfUnreferenced(attachment.path).catch((cleanupError) => {
            req.log.warn(cleanupError, `清理孤儿附件失败: ${attachment.path}`)
          })
        }
      } else {
        await cleanupAttachmentInputs(attachments)
      }
      if (error instanceof ClientInputError) return reply.code(400).send({ error: error.message })
      if (error instanceof MemoNotFoundError) return reply.code(404).send({ error: error.message })
      throw error
    }
  }))

  // 5. 删除 Memo
  app.delete('/:id', async (req, reply) => withMemoMutationLock(async () => {
    const { id } = req.params as { id: string }
    const memo = await prisma.memo.findUnique({ where: { id }, include: { attachments: true } })
    if (!memo) return reply.code(404).send({ error: '记事不存在' })

    try {
      await prisma.memo.delete({ where: { id } })
    } catch (error: any) {
      if (error?.code === 'P2025') return reply.code(404).send({ error: '记事不存在' })
      throw error
    }
    for (const attachment of memo.attachments) {
      await removeUploadIfUnreferenced(attachment.path).catch((error) => {
        req.log.warn(error, `清理附件失败: ${attachment.path}`)
      })
    }
    return { ok: true }
  }))
}
