import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'

const TAG_TYPES = new Set(['time', 'count'])
const TAG_MODES = new Set(['chaos', 'ordered'])
const MAX_NAME_LENGTH = 100
const MAX_ICON_LENGTH = 32

function optionalString(value: unknown, field: string, max: number, allowNull = false): string | undefined | null {
  if (value === undefined) return undefined
  if (value === null && allowNull) return null
  if (typeof value !== 'string' || value.length > max) throw new Error(`${field} 无效`)
  return value
}

function optionalSortOrder(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || (value as number) < -100000 || (value as number) > 100000) throw new Error('sortOrder 无效')
  return value as number
}

function optionalColor(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^#[0-9a-f]{3,8}$/i.test(value)) throw new Error('color 无效')
  return value
}

export default async function tagRoutes(app: FastifyInstance) {
  // 列出所有标签（含分类信息）
  app.get('/', async () => {
    return prisma.tag.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: { category: true },
    })
  })

  // 创建标签
  app.post('/', async (req, reply) => {
    const { name, color, icon, categoryId, sortOrder, trackType, mode } = (req.body ?? {}) as {
      name: string
      color?: string
      icon?: string
      categoryId?: string
      sortOrder?: number
      trackType?: string
      mode?: string
    }
    if (typeof name !== 'string' || !name.trim() || name.length > MAX_NAME_LENGTH) {
      return reply.code(400).send({ error: `名称不能为空且不能超过 ${MAX_NAME_LENGTH} 个字符` })
    }
    const nextTrackType = trackType ?? 'time'
    if (!TAG_TYPES.has(nextTrackType)) return reply.code(400).send({ error: 'trackType 只能是 time 或 count' })
    const nextMode = mode ?? 'chaos'
    if (!TAG_MODES.has(nextMode)) return reply.code(400).send({ error: 'mode 只能是 chaos 或 ordered' })
    if (categoryId !== undefined && categoryId !== null && typeof categoryId !== 'string') {
      return reply.code(400).send({ error: 'categoryId 无效' })
    }
    let safeColor: string | undefined
    let safeIcon: string | null | undefined
    let safeSortOrder: number | undefined
    try {
      safeColor = optionalColor(color)
      safeIcon = optionalString(icon, 'icon', MAX_ICON_LENGTH, true)
      safeSortOrder = optionalSortOrder(sortOrder)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : '标签参数无效' })
    }
    try {
      if (categoryId) {
        const category = await prisma.category.findUnique({ where: { id: categoryId }, select: { id: true } })
        if (!category) return reply.code(404).send({ error: '分类不存在' })
      }
      const duplicate = await prisma.tag.findFirst({
        where: { name: name.trim(), categoryId: categoryId || null },
        select: { id: true },
      })
      if (duplicate) return reply.code(409).send({ error: '该分类下已存在同名标签' })
      return await prisma.tag.create({
        data: {
          name: name.trim(), color: safeColor ?? undefined, icon: safeIcon,
          categoryId: categoryId || null, sortOrder: safeSortOrder, trackType: nextTrackType, mode: nextMode,
        },
        include: { category: true },
      })
    } catch (e: any) {
      if (e?.code === 'P2002') return reply.code(409).send({ error: '创建失败，该分类下名称可能已存在' })
      throw e
    }
  })

  // 更新标签
  app.put('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { name, color, icon, categoryId, sortOrder, trackType, mode } = (req.body ?? {}) as {
      name?: string
      color?: string
      icon?: string
      categoryId?: string | null
      sortOrder?: number
      trackType?: string
      mode?: string
    }
    if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > MAX_NAME_LENGTH)) {
      return reply.code(400).send({ error: `名称不能为空且不能超过 ${MAX_NAME_LENGTH} 个字符` })
    }
    if (trackType !== undefined && !TAG_TYPES.has(trackType)) {
      return reply.code(400).send({ error: 'trackType 只能是 time 或 count' })
    }
    if (mode !== undefined && !TAG_MODES.has(mode)) {
      return reply.code(400).send({ error: 'mode 只能是 chaos 或 ordered' })
    }
    if (categoryId !== undefined && categoryId !== null && typeof categoryId !== 'string') {
      return reply.code(400).send({ error: 'categoryId 无效' })
    }
    let safeColor: string | undefined
    let safeIcon: string | null | undefined
    let safeSortOrder: number | undefined
    try {
      safeColor = optionalColor(color)
      safeIcon = optionalString(icon, 'icon', MAX_ICON_LENGTH, true)
      safeSortOrder = optionalSortOrder(sortOrder)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : '标签参数无效' })
    }
    try {
      if (categoryId) {
        const category = await prisma.category.findUnique({ where: { id: categoryId }, select: { id: true } })
        if (!category) return reply.code(404).send({ error: '分类不存在' })
      }
      if (name !== undefined || categoryId !== undefined) {
        const existing = await prisma.tag.findUnique({ where: { id }, select: { name: true, categoryId: true } })
        if (!existing) return reply.code(404).send({ error: '标签不存在' })
        const nextName = name?.trim() ?? existing.name
        const nextCategoryId = categoryId === undefined ? existing.categoryId : categoryId || null
        const duplicate = await prisma.tag.findFirst({
          where: {
            name: nextName,
            categoryId: nextCategoryId,
            id: { not: id },
          },
          select: { id: true },
        })
        if (duplicate) return reply.code(409).send({ error: '该分类下已存在同名标签' })
      }
      return await prisma.tag.update({
        where: { id },
        data: {
          ...(name !== undefined ? { name: name.trim() } : {}),
          ...(color !== undefined ? { color: safeColor } : {}),
          ...(icon !== undefined ? { icon: safeIcon } : {}),
          ...(categoryId !== undefined ? { categoryId } : {}),
          ...(sortOrder !== undefined ? { sortOrder: safeSortOrder } : {}),
          ...(trackType !== undefined ? { trackType } : {}),
          ...(mode !== undefined ? { mode } : {}),
        },
        include: { category: true },
      })
    } catch (e: any) {
      if (e?.code === 'P2002') return reply.code(409).send({ error: '该分类下已存在同名标签' })
      if (e?.code === 'P2025') return reply.code(404).send({ error: '标签不存在' })
      throw e
    }
  })

  // 删除标签（若有关联时间记录则拒绝，保护历史数据）
  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const count = await prisma.timeEntry.count({ where: { tagId: id } })
    if (count > 0) {
      reply.code(409)
      return {
        error: `该标签有 ${count} 条时间记录，删除会丢失历史统计。请先迁移记录或归档标签。`,
      }
    }
    try {
      await prisma.tag.delete({ where: { id } })
    } catch {
      return reply.code(404).send({ error: '标签不存在' })
    }
    return { ok: true }
  })
}
