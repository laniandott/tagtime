import type { FastifyInstance } from 'fastify'
import { join, resolve } from 'node:path'
import { mkdirSync, existsSync, writeFileSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import prisma from '../db.js'

// 确保上传目录存在
const DATA_DIR = process.env.DATA_DIR
  ? resolve(process.env.DATA_DIR)
  : existsSync('/data')
  ? '/data'
  : resolve(process.cwd(), 'data')

const UPLOAD_DIR = join(DATA_DIR, 'uploads')

if (!existsSync(UPLOAD_DIR)) {
  mkdirSync(UPLOAD_DIR, { recursive: true })
}

export { UPLOAD_DIR }

export default async function memoRoutes(app: FastifyInstance) {
  // 1. 获取 Memos 列表（支持时间切片或绑定计时ID）
  app.get('/', async (req) => {
    const { timeEntryId, tagId, days, from, to } = req.query as {
      timeEntryId?: string
      tagId?: string
      days?: string
      from?: string
      to?: string
    }

    const where: Record<string, unknown> = {}
    if (timeEntryId) where.timeEntryId = timeEntryId
    if (tagId) where.tagId = tagId

    if (from || to || days) {
      where.createdAt = {}
      if (from) {
        (where.createdAt as { gte?: Date }).gte = new Date(from)
      } else if (days) {
        const d = new Date()
        d.setDate(d.getDate() - (Number(days) - 1))
        d.setHours(0, 0, 0, 0)
        ;(where.createdAt as { gte?: Date }).gte = d
      }

      if (to) {
        (where.createdAt as { lte?: Date }).lte = new Date(to)
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
    })
  })

  // 2. 创建 Memo（支持自定义创建时间）
  app.post('/', async (req, reply) => {
    const { content, timeEntryId, tagId, attachments, createdAt } = req.body as {
      content: string
      timeEntryId?: string
      tagId?: string
      createdAt?: string
      attachments?: { filename: string; path: string; mimeType: string; size: number }[]
    }

    if (!content || !content.trim()) {
      reply.code(400)
      return { error: '内容不能为空' }
    }

    const memo = await prisma.memo.create({
      data: {
        content: content.trim(),
        timeEntryId: timeEntryId || null,
        tagId: tagId || null,
        createdAt: createdAt ? new Date(createdAt) : undefined,
        attachments: attachments
          ? {
              create: attachments.map((a) => ({
                filename: a.filename,
                path: a.path,
                mimeType: a.mimeType,
                size: a.size,
              })),
            }
          : undefined,
      },
      include: {
        attachments: true,
        tag: { include: { category: true } },
        timeEntry: { include: { tag: { include: { category: true } } } },
      },
    })

    return memo
  })

  // 3. 上传图片或视频接口
  app.post('/upload', async (req, reply) => {
    const data = await req.file()
    if (!data) {
      reply.code(400)
      return { error: '未检测到上传文件' }
    }

    const ext = data.filename.split('.').pop() ?? 'bin'
    const fileName = `${Date.now()}_${randomUUID().slice(0, 8)}.${ext}`
    const filePath = join(UPLOAD_DIR, fileName)

    const buffer = await data.toBuffer()
    writeFileSync(filePath, buffer)

    return {
      filename: data.filename,
      path: `/uploads/${fileName}`,
      mimeType: data.mimetype,
      size: buffer.length,
    }
  })

  // 4. 编辑 Memo（内容、时间、附件增删）
  app.put('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { content, createdAt, attachments } = req.body as {
      content?: string
      createdAt?: string
      attachments?: { filename: string; path: string; mimeType: string; size: number }[]
    }

    // 如果传了新的 attachments 列表，先删除旧附件文件，再重建关联
    if (attachments) {
      const oldAtts = await prisma.attachment.findMany({ where: { memoId: id } })
      for (const att of oldAtts) {
        const fileName = att.path.replace('/uploads/', '')
        const fullPath = join(UPLOAD_DIR, fileName)
        if (existsSync(fullPath)) {
          try { unlinkSync(fullPath) } catch {}
        }
      }
      await prisma.attachment.deleteMany({ where: { memoId: id } })
      await prisma.attachment.createMany({
        data: attachments.map((a) => ({
          memoId: id,
          filename: a.filename,
          path: a.path,
          mimeType: a.mimeType,
          size: a.size,
        })),
      })
    }

    try {
      const updated = await prisma.memo.update({
        where: { id },
        data: {
          ...(content !== undefined ? { content: content.trim() } : {}),
          ...(createdAt !== undefined ? { createdAt: new Date(createdAt) } : {}),
        },
        include: {
          attachments: true,
          tag: { include: { category: true } },
          timeEntry: { include: { tag: { include: { category: true } } } },
        },
      })
      return updated
    } catch {
      reply.code(404)
      return { error: '记事不存在' }
    }
  })

  // 5. 删除 Memo
  app.delete('/:id', async (req) => {
    const { id } = req.params as { id: string }

    // 删除关联的本地磁盘文件
    const attachments = await prisma.attachment.findMany({ where: { memoId: id } })
    for (const att of attachments) {
      const fileName = att.path.replace('/uploads/', '')
      const fullPath = join(UPLOAD_DIR, fileName)
      if (existsSync(fullPath)) {
        try {
          unlinkSync(fullPath)
        } catch (e) {
          // ignore cleanup errors
        }
      }
    }

    await prisma.memo.delete({ where: { id } })
    return { ok: true }
  })
}
