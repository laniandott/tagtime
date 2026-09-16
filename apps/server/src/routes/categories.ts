import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'

const MAX_NAME_LENGTH = 100
const MAX_ICON_LENGTH = 32

function validateOptionalStyle(value: unknown, field: string, maxLength: number, allowNull = false): string | undefined | null {
  if (value === undefined) return undefined
  if (value === null) {
    if (allowNull) return null
    throw new Error(`${field} 无效`)
  }
  if (typeof value !== 'string' || value.length > maxLength) throw new Error(`${field} 无效`)
  return value
}

function validateSortOrder(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || (value as number) < -100000 || (value as number) > 100000) throw new Error('sortOrder 无效')
  return value as number
}

function validateColor(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^#[0-9a-f]{3,8}$/i.test(value)) throw new Error('color 无效')
  return value
}

export default async function categoryRoutes(app: FastifyInstance) {
  // 列出所有分类（按 sortOrder 排序）
  app.get('/', async () => {
    return prisma.category.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: { _count: { select: { tags: true } } },
    })
  })

  // 创建分类
  app.post('/', async (req, reply) => {
    const { name, color, icon, sortOrder } = (req.body ?? {}) as {
      name: string
      color?: string
      icon?: string
      sortOrder?: number
    }
    if (typeof name !== 'string' || !name.trim() || name.length > MAX_NAME_LENGTH) {
      return reply.code(400).send({ error: `名称不能为空且不能超过 ${MAX_NAME_LENGTH} 个字符` })
    }
    let safeColor: string | undefined
    let safeIcon: string | null | undefined
    let safeSortOrder: number | undefined
    try {
      safeColor = validateColor(color)
      safeIcon = validateOptionalStyle(icon, 'icon', MAX_ICON_LENGTH, true)
      safeSortOrder = validateSortOrder(sortOrder)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : '分类参数无效' })
    }
    try {
      const category = await prisma.category.create({
        data: { name: name.trim(), color: safeColor ?? undefined, icon: safeIcon, sortOrder: safeSortOrder },
      })
      return category
    } catch (e: any) {
      if (e?.code === 'P2002') return reply.code(409).send({ error: '创建失败，名称可能已存在' })
      throw e
    }
  })

  // 更新分类
  app.put('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { name, color, icon, sortOrder } = (req.body ?? {}) as {
      name?: string
      color?: string
      icon?: string
      sortOrder?: number
    }
    if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > MAX_NAME_LENGTH)) {
      return reply.code(400).send({ error: `名称不能为空且不能超过 ${MAX_NAME_LENGTH} 个字符` })
    }
    let safeColor: string | undefined
    let safeIcon: string | null | undefined
    let safeSortOrder: number | undefined
    try {
      safeColor = validateColor(color)
      safeIcon = validateOptionalStyle(icon, 'icon', MAX_ICON_LENGTH, true)
      safeSortOrder = validateSortOrder(sortOrder)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : '分类参数无效' })
    }
    try {
      return await prisma.category.update({
        where: { id },
        data: {
          ...(name !== undefined ? { name: name.trim() } : {}),
          ...(color !== undefined ? { color: safeColor } : {}),
          ...(icon !== undefined ? { icon: safeIcon } : {}),
          ...(sortOrder !== undefined ? { sortOrder: safeSortOrder } : {}),
        },
      })
    } catch (e: any) {
      if (e?.code === 'P2002') return reply.code(409).send({ error: '分类名称可能已存在' })
      if (e?.code === 'P2025') return reply.code(404).send({ error: '分类不存在' })
      throw e
    }
  })

  // 删除分类（标签的 categoryId 置空）
  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    try {
      await prisma.category.delete({ where: { id } })
    } catch {
      return reply.code(404).send({ error: '分类不存在' })
    }
    return { ok: true }
  })
}
