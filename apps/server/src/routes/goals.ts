import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'

// 计算时长（毫秒），endTime 为空则用当前时间
function durationMs(start: Date, end: Date | null): number {
  return (end ?? new Date()).getTime() - start.getTime()
}

// 根据周期计算当前周期的起始时间
function periodStart(period: string, periodDays?: number | null): Date {
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  switch (period) {
    case 'daily':
      return todayStart
    case 'weekly': {
      const dayOfWeek = now.getDay() || 7 // 周日=7
      const start = new Date(todayStart)
      start.setDate(start.getDate() - (dayOfWeek - 1))
      return start
    }
    case 'monthly':
      return new Date(now.getFullYear(), now.getMonth(), 1)
    case 'custom': {
      const days = periodDays ?? 7
      const start = new Date(todayStart)
      start.setDate(start.getDate() - (days - 1))
      return start
    }
    default:
      return todayStart
  }
}

export default async function goalRoutes(app: FastifyInstance) {
  // 列出所有目标（含关联标签和进度）
  app.get('/', async () => {
    const goals = await prisma.goal.findMany({
      where: { active: true },
      include: { tag: { include: { category: true } } },
      orderBy: { createdAt: 'desc' },
    })
    if (goals.length === 0) return []

    // 单次查询所有相关标签的记录（从最早的周期起点开始），再在内存中按目标分组，避免 N+1
    const now = new Date()
    const earliest = goals
      .map((g) => periodStart(g.period, g.periodDays))
      .reduce((min, s) => (s < min ? s : min))
    const tagIds = [...new Set(goals.map((g) => g.tagId))]
    const allEntries = await prisma.timeEntry.findMany({
      where: { tagId: { in: tagIds }, startTime: { gte: earliest, lte: now } },
      select: { tagId: true, startTime: true, endTime: true },
    })

    const result = goals.map((goal) => {
      const start = periodStart(goal.period, goal.periodDays)
      const entries = allEntries.filter(
        (e) => e.tagId === goal.tagId && e.startTime >= start
      )

      let current: number
      if (goal.type === 'count') {
        // 次数型：统计记录条数
        current = entries.length
      } else {
        // 时长型：统计总分钟数
        const totalMs = entries.reduce((s, e) => s + durationMs(e.startTime, e.endTime), 0)
        current = Math.floor(totalMs / 60000)
      }

      return {
        ...goal,
        current,
        periodStart: start.toISOString(),
        percent: Math.min(100, Math.round((current / goal.target) * 100)),
      }
    })
    return result
  })

  // 创建目标
  app.post('/', async (req, reply) => {
    const { tagId, title, type, target, period, periodDays } = req.body as {
      tagId: string
      title: string
      type?: string
      target?: number
      period?: string
      periodDays?: number
    }
    if (!tagId || !title.trim()) {
      reply.code(400)
      return { error: 'tagId 和 title 为必填' }
    }
    return prisma.goal.create({
      data: {
        tagId,
        title: title.trim(),
        type: type ?? 'count',
        target: target ?? 1,
        period: period ?? 'daily',
        periodDays: period === 'custom' ? (periodDays ?? 7) : null,
      },
      include: { tag: true },
    })
  })

  // 更新目标
  app.put('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { title, type, target, period, periodDays, active } = req.body as {
      title?: string
      type?: string
      target?: number
      period?: string
      periodDays?: number | null
      active?: boolean
    }
    try {
      return await prisma.goal.update({
        where: { id },
        data: {
          title,
          type,
          target,
          period,
          periodDays: period === 'custom' ? periodDays : null,
          active,
        },
        include: { tag: true },
      })
    } catch {
      reply.code(404)
      return { error: '目标不存在' }
    }
  })

  // 删除目标
  app.delete('/:id', async (req) => {
    const { id } = req.params as { id: string }
    await prisma.goal.delete({ where: { id } })
    return { ok: true }
  })
}
