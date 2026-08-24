import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'

// 辅助函数：将 Date 格式化为 iCalendar UTC 时间 (用于 DTSTAMP: YYYYMMDDTHHMMSSZ)
function formatIcsUtcDate(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

// 辅助函数：将 Date 格式化为 Asia/Shanghai 本地时间 (YYYYMMDDTHHMMSS)
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

// 辅助函数：根据 Hex 颜色智能映射为彩色圆点 Emoji
function getColoredCircle(hex?: string): string {
  if (!hex || !hex.startsWith('#')) return '🏷️'
  const r = parseInt(hex.slice(1, 3), 16) || 0
  const g = parseInt(hex.slice(3, 5), 16) || 0
  const b = parseInt(hex.slice(5, 7), 16) || 0
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  if (d < 30) return max > 180 ? '⚪' : '🔘'
  let h = 0
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60
  else if (max === g) h = ((b - r) / d + 2) * 60
  else h = ((r - g) / d + 4) * 60
  if (h >= 345 || h < 18) return '🔴'
  if (h >= 18 && h < 45) return '🟠'
  if (h >= 45 && h < 75) return '🟡'
  if (h >= 75 && h < 165) return '🟢'
  if (h >= 165 && h < 260) return '🔵'
  if (h >= 260 && h < 345) return '🟣'
  return '🔵'
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
    const { days, categoryId, tagId, all, tz } = req.query as {
      days?: string
      categoryId?: string
      tagId?: string
      all?: string
      tz?: string
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
    // Always include an explicit timezone. Floating DTSTART values are parsed
    // inconsistently by Google Calendar subscriptions and can shift by hours.
    // Keep `tz=floating` as an opt-out for legacy clients only.
    const useExplicitTz = tz !== 'floating'

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
    ]

    if (useExplicitTz) {
      lines.push(
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
      )
    }

    for (const entry of entries) {
      if (!entry.endTime) continue

      const catName = entry.tag.category?.name
      const tagColor = entry.tag.color || entry.tag.category?.color
      const colorIndicator = entry.tag.icon || getColoredCircle(tagColor)
      const summaryParts = []
      if (catName) summaryParts.push(`[${catName}]`)
      summaryParts.push(`${colorIndicator} ${entry.tag.name}`)
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
      const localStart = formatIcsLocalDate(entry.startTime)
      const localEnd = formatIcsLocalDate(entry.endTime)

      lines.push('BEGIN:VEVENT')
      lines.push(`UID:timeentry-${entry.id}@tagtime`)
      lines.push(`DTSTAMP:${nowStr}`)

      // 默认使用 RFC 5545 浮动本地时间，不受 Google/客户端账号异地时区偏移影响
      if (useExplicitTz) {
        lines.push(`DTSTART;TZID=Asia/Shanghai:${localStart}`)
        lines.push(`DTEND;TZID=Asia/Shanghai:${localEnd}`)
      } else {
        lines.push(`DTSTART:${localStart}`)
        lines.push(`DTEND:${localEnd}`)
      }

      lines.push(`SUMMARY:${escapeIcsText(summary)}`)
      lines.push(`DESCRIPTION:${escapeIcsText(description)}`)
      lines.push(`CATEGORIES:${escapeIcsText(catName || 'TagTime')}`)
      lines.push('STATUS:CONFIRMED')
      if (tagColor) {
        lines.push(`COLOR:${tagColor}`)
        lines.push(`X-APPLE-CALENDAR-COLOR:${tagColor}`)
        lines.push(`APPLE-COLOR:${tagColor}`)
        lines.push(`X-COLOR:${tagColor}`)
        lines.push(`X-MOZ-COLOR:${tagColor}`)
        lines.push(`X-OUTLOOK-COLOR:${tagColor}`)
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
