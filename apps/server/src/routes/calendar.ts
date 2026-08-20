import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'

// 辅助函数：将 Date 格式化为 iCalendar UTC 时间 (用于 DTSTAMP: YYYYMMDDTHHMMSSZ)
function formatIcsUtcDate(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

// 辅助函数：将 Date 格式化为 Asia/Shanghai 本地时间 (用于 DTSTART/DTEND: YYYYMMDDTHHMMSS)
function formatIcsLocalDate(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date)

  const map: Record<string, string> = {}
  parts.forEach((p) => {
    map[p.type] = p.value
  })
  return `${map.year}${map.month}${map.day}T${map.hour}${map.minute}${map.second}`
}

// 辅助函数：转义 iCalendar 文本字段中的特殊字符 (\, ;, ,, 换行)
function escapeIcsText(text: string): string {
  if (!text) return ''
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n')
}

export default async function calendarRoutes(app: FastifyInstance) {
  // 生成 iCalendar (.ics) 日历订阅源与下载
  app.get('/feed.ics', async (req, reply) => {
    const { days, categoryId, tagId, all } = req.query as {
      days?: string
      categoryId?: string
      tagId?: string
      all?: string
    }

    const where: Record<string, unknown> = {
      endTime: { not: null }, // 只同步已完成的计时活动
    }

    if (tagId) {
      where.tagId = tagId
    } else if (categoryId) {
      if (categoryId === 'none') {
        where.tag = { categoryId: null }
      } else {
        where.tag = { categoryId }
      }
    }

    // 默认同步最近 90 天，除非显式指定 all=true 或 days=0
    if (all !== 'true' && all !== '1' && days !== '0') {
      const dayCount = days ? parseInt(days, 10) || 90 : 90
      const sinceDate = new Date()
      sinceDate.setDate(sinceDate.getDate() - dayCount)
      where.startTime = { gte: sinceDate }
    }

    const entries = await prisma.timeEntry.findMany({
      where,
      include: {
        tag: {
          include: { category: true },
        },
        todo: true,
        memos: {
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { startTime: 'desc' },
      take: 2000, // 保护最大记录数
    })

    const nowStr = formatIcsUtcDate(new Date())

    const lines: string[] = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//TagTime//Activity Tracker//CN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:TagTime 活动记录',
      'X-WR-TIMEZONE:Asia/Shanghai',
      'X-WR-CALDESC:TagTime 时间记录与活动同步',
      'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
      'X-PUBLISHED-TTL:PT1H',
      'BEGIN:VTIMEZONE',
      'TZID:Asia/Shanghai',
      'X-LIC-LOCATION:Asia/Shanghai',
      'BEGIN:STANDARD',
      'TZOFFSETFROM:+0800',
      'TZOFFSETTO:+0800',
      'TZNAME:CST',
      'DTSTART:19700101T000000',
      'END:STANDARD',
      'END:VTIMEZONE',
    ]

    for (const entry of entries) {
      if (!entry.endTime) continue

      const catName = entry.tag.category?.name
      const tagIcon = entry.tag.icon ? `${entry.tag.icon} ` : ''
      const summaryParts = []
      if (catName) summaryParts.push(`[${catName}]`)
      summaryParts.push(`${tagIcon}${entry.tag.name}`)
      if (entry.note) summaryParts.push(`- ${entry.note}`)
      const summary = summaryParts.join(' ')

      // 组装详细描述
      const descLines: string[] = []
      descLines.push(`🏷️ 标签: ${entry.tag.name}`)
      if (catName) descLines.push(`📁 分类: ${catName}`)
      if (entry.note) descLines.push(`📝 备注: ${entry.note}`)
      if (entry.todo) descLines.push(`✅ 关联待办: ${entry.todo.title}`)

      // 区分打点记录与日记
      const pointMemos = entry.memos.filter((m) => m.type === 'point')
      const diaryMemos = entry.memos.filter((m) => m.type !== 'point')

      if (pointMemos.length > 0) {
        descLines.push('')
        descLines.push(`📍 里程碑打点 (${pointMemos.length} 条):`)
        pointMemos.forEach((m) => {
          const t = new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour12: false })
          descLines.push(`  • [${t}] ${m.content}`)
        })
      }

      if (diaryMemos.length > 0) {
        descLines.push('')
        descLines.push(`📖 关联日记 (${diaryMemos.length} 篇):`)
        diaryMemos.forEach((m) => {
          descLines.push(`  • ${m.content}`)
        })
      }

      const description = descLines.join('\n')

      lines.push('BEGIN:VEVENT')
      lines.push(`UID:timeentry-${entry.id}@tagtime`)
      lines.push(`DTSTAMP:${nowStr}`)
      lines.push(`DTSTART;TZID=Asia/Shanghai:${formatIcsLocalDate(entry.startTime)}`)
      lines.push(`DTEND;TZID=Asia/Shanghai:${formatIcsLocalDate(entry.endTime)}`)
      lines.push(`SUMMARY:${escapeIcsText(summary)}`)
      lines.push(`DESCRIPTION:${escapeIcsText(description)}`)
      lines.push(`CATEGORIES:${escapeIcsText(catName || 'TagTime')}`)
      lines.push('STATUS:CONFIRMED')
      if (entry.tag.color) {
        lines.push(`X-APPLE-CALENDAR-COLOR:${entry.tag.color}`)
      }
      lines.push('END:VEVENT')
    }

    lines.push('END:VCALENDAR')
    const icsContent = lines.join('\r\n')

    reply
      .header('Content-Type', 'text/calendar; charset=utf-8')
      .header('Content-Disposition', 'inline; filename="tagtime_calendar.ics"')
      .header('Cache-Control', 'no-cache, no-store, must-revalidate')
      .send(icsContent)
  })
}
