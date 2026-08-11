import { useEffect, useState, useMemo, useRef, useCallback } from 'react'
import { api, resolveUploadUrl } from '../api'
import { formatDuration, useStore } from '../store'
import type { TimeEntry, Memo } from '../types'
import { MemoCreateModal, MemoEditModal } from './TimerPage'
import { DateTimeSecondPicker } from '../components/DateTimeSecondPicker'

// ===== 日期工具函数 =====

function startOfDay(d: Date): Date {
  const r = new Date(d)
  r.setHours(0, 0, 0, 0)
  return r
}

function endOfDay(d: Date): Date {
  const r = new Date(d)
  r.setHours(23, 59, 59, 999)
  return r
}

// 周一为一周的第一天
function startOfWeek(d: Date): Date {
  const r = startOfDay(d)
  const day = r.getDay()
  const diff = day === 0 ? -6 : 1 - day
  r.setDate(r.getDate() + diff)
  return r
}

function endOfWeek(d: Date): Date {
  const s = startOfWeek(d)
  const r = new Date(s)
  r.setDate(r.getDate() + 6)
  return endOfDay(r)
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999)
}

function getWeekDays(d: Date): Date[] {
  const start = startOfWeek(d)
  return Array.from({ length: 7 }, (_, i) => {
    const r = new Date(start)
    r.setDate(r.getDate() + i)
    return r
  })
}

function getMonthGrid(d: Date): Date[] {
  const start = startOfWeek(startOfMonth(d))
  const end = endOfWeek(endOfMonth(d))
  const days: Date[] = []
  const cur = new Date(start)
  while (cur <= end) {
    days.push(new Date(cur))
    cur.setDate(cur.getDate() + 1)
  }
  return days
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
}

function isSameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()
}

function isToday(d: Date): boolean {
  return isSameDay(d, new Date())
}

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']
const WEEKDAYS_FULL = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

function formatDateRange(start: Date, end: Date): string {
  if (start.getMonth() === end.getMonth()) {
    return `${start.getMonth() + 1}月${start.getDate()}日 - ${end.getDate()}日`
  }
  return `${start.getMonth() + 1}月${start.getDate()}日 - ${end.getMonth() + 1}月${end.getDate()}日`
}

function minutesFromStartOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60
}

// ===== 重叠布局算法（同 Google Calendar）=====

interface LayoutItem {
  entry: TimeEntry
  start: number
  end: number
  col: number
  cols: number
}

function layoutEntries(entries: TimeEntry[], dayStart: number, dayEnd: number): LayoutItem[] {
  const items = entries
    .map((entry) => {
      const start = Math.max(new Date(entry.startTime).getTime(), dayStart)
      const end = Math.min(
        entry.endTime ? new Date(entry.endTime).getTime() : Date.now(),
        dayEnd
      )
      return { entry, start, end }
    })
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start)

  if (items.length === 0) return []

  // 分组重叠的条目
  const groups: (typeof items)[] = []
  let currentGroup: typeof items = []
  let currentEnd = 0

  for (const item of items) {
    if (item.start >= currentEnd && currentGroup.length > 0) {
      groups.push(currentGroup)
      currentGroup = []
    }
    currentGroup.push(item)
    currentEnd = Math.max(currentEnd, item.end)
  }
  if (currentGroup.length > 0) groups.push(currentGroup)

  // 在每组内分配列
  const result: LayoutItem[] = []
  for (const group of groups) {
    const columns: number[] = []
    const colMap: number[] = []
    for (const item of group) {
      let col = -1
      for (let i = 0; i < columns.length; i++) {
        if (columns[i] <= item.start) { col = i; break }
      }
      if (col === -1) { col = columns.length; columns.push(0) }
      columns[col] = item.end
      colMap.push(col)
    }
    const totalCols = columns.length
    group.forEach((item, i) => {
      result.push({ ...item, col: colMap[i], cols: totalCols })
    })
  }

  return result
}

// ===== 主组件 =====

const HOUR_HEIGHT_DAY = 60
const HOUR_HEIGHT_WEEK = 48

export default function CalendarPage() {
  const [view, setView] = useState<'day' | 'week' | 'month'>('week')
  const [currentDate, setCurrentDate] = useState(new Date())
  const [entries, setEntries] = useState<TimeEntry[]>([])
  const [selectedEntry, setSelectedEntry] = useState<TimeEntry | null>(null)
  const [now, setNow] = useState(new Date())

  // 每分钟更新当前时间（用于"现在"指示线）
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60000)
    return () => clearInterval(t)
  }, [])

  // 计算日期范围
  const range = useMemo(() => {
    switch (view) {
      case 'day':
        return { from: startOfDay(currentDate), to: endOfDay(currentDate) }
      case 'week':
        return { from: startOfWeek(currentDate), to: endOfWeek(currentDate) }
      case 'month':
        return {
          from: startOfWeek(startOfMonth(currentDate)),
          to: endOfWeek(endOfMonth(currentDate)),
        }
    }
  }, [view, currentDate])

  // 加载数据
  useEffect(() => {
    api.timer
      .list({
        from: range.from.toISOString(),
        to: range.to.toISOString(),
      })
      .then(setEntries)
      .catch(() => setEntries([]))
  }, [range.from, range.to])

  // 导航
  const navigate = (dir: number) => {
    const d = new Date(currentDate)
    switch (view) {
      case 'day': d.setDate(d.getDate() + dir); break
      case 'week': d.setDate(d.getDate() + dir * 7); break
      case 'month': d.setMonth(d.getMonth() + dir); break
    }
    setCurrentDate(d)
  }

  // 按天分组条目（跨午夜的计时会出现在它跨越的每一天）
  const entriesByDay = useMemo(() => {
    const map = new Map<string, TimeEntry[]>()
    for (const e of entries) {
      const entryStart = startOfDay(new Date(e.startTime))
      const entryEnd = e.endTime ? startOfDay(new Date(e.endTime)) : startOfDay(new Date())
      // 遍历计时跨越的每一天
      const cur = new Date(entryStart)
      while (cur <= entryEnd) {
        const dayKey = cur.toISOString()
        if (!map.has(dayKey)) map.set(dayKey, [])
        map.get(dayKey)!.push(e)
        cur.setDate(cur.getDate() + 1)
      }
    }
    return map
  }, [entries])

  // 计算当日总时长（跨午夜计时只计算当天部分）
  const dayTotal = useCallback((day: Date): number => {
    const key = startOfDay(day).toISOString()
    const dayEntries = entriesByDay.get(key) ?? []
    const dStart = startOfDay(day).getTime()
    const dEnd = endOfDay(day).getTime()
    return dayEntries.reduce((sum, e) => {
      const eStart = new Date(e.startTime).getTime()
      const eEnd = e.endTime ? new Date(e.endTime).getTime() : Date.now()
      // 裁剪到当天范围
      const clippedStart = Math.max(eStart, dStart)
      const clippedEnd = Math.min(eEnd, dEnd)
      return sum + (clippedEnd - clippedStart)
    }, 0)
  }, [entriesByDay])

  // 当前周期总时长
  const periodTotal = useMemo(() => {
    return entries.reduce((sum, e) => {
      const end = e.endTime ? new Date(e.endTime).getTime() : Date.now()
      return sum + (end - new Date(e.startTime).getTime())
    }, 0)
  }, [entries])

  // 标题
  const title = useMemo(() => {
    switch (view) {
      case 'day':
        return `${currentDate.getFullYear()}年${currentDate.getMonth() + 1}月${currentDate.getDate()}日`
      case 'week':
        return formatDateRange(startOfWeek(currentDate), endOfWeek(currentDate))
      case 'month':
        return `${currentDate.getFullYear()}年${currentDate.getMonth() + 1}月`
    }
  }, [view, currentDate])

  return (
    <div className="space-y-4">
      {/* 头部：标题 + 导航 + 视图切换 */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate(-1)}
            className="w-8 h-8 rounded-lg border border-gray-200 dark:border-gray-800 flex items-center justify-center hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500"
          >
            ‹
          </button>
          <h1 className="text-lg font-bold min-w-[120px] text-center">{title}</h1>
          <button
            onClick={() => navigate(1)}
            className="w-8 h-8 rounded-lg border border-gray-200 dark:border-gray-800 flex items-center justify-center hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500"
          >
            ›
          </button>
          {!isToday(currentDate) && (
            <button
              onClick={() => setCurrentDate(new Date())}
              className="ml-1 px-3 py-1 rounded-lg text-sm border border-gray-200 dark:border-gray-800 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
            >
              今天
            </button>
          )}
        </div>
        <div className="flex items-center gap-3">
          {periodTotal > 0 && (
            <span className="text-sm text-gray-400">
              合计 <span className="font-mono font-medium text-gray-600 dark:text-gray-300">{formatDuration(periodTotal)}</span>
            </span>
          )}
          <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-0.5">
            {(['day', 'week', 'month'] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${
                  view === v
                    ? 'bg-white dark:bg-gray-700 text-brand shadow-sm'
                    : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                {v === 'day' ? '日' : v === 'week' ? '周' : '月'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 日历主体 */}
      {entries.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-gray-300 dark:border-gray-700 p-12 text-center text-gray-400">
          <div className="text-4xl mb-2">📅</div>
          <div>该时段暂无时间记录</div>
        </div>
      ) : view === 'day' ? (
        <DayView date={currentDate} entries={entries} now={now} onEntryClick={setSelectedEntry} />
      ) : view === 'week' ? (
        <WeekView weekStart={startOfWeek(currentDate)} entries={entries} now={now} onEntryClick={setSelectedEntry} />
      ) : (
        <MonthView
          date={currentDate}
          entriesByDay={entriesByDay}
          dayTotal={dayTotal}
          onDayClick={(d) => { setCurrentDate(d); setView('day') }}
        />
      )}

      {/* 条目详情弹窗 */}
      {selectedEntry && <EntryDetail entry={selectedEntry} onClose={() => setSelectedEntry(null)} />}

      {/* 沉浸式动态时间线 (Memos & 多媒体) */}
      <TimelineSection />
    </div>
  )
}

// ===== 日视图 =====

function DayView({ date, entries, now, onEntryClick }: {
  date: Date
  entries: TimeEntry[]
  now: Date
  onEntryClick: (e: TimeEntry) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const dayStart = startOfDay(date).getTime()
  const dayEnd = endOfDay(date).getTime()
  const layout = layoutEntries(entries, dayStart, dayEnd)

  // 自动滚动到当前时间附近
  useEffect(() => {
    if (!scrollRef.current) return
    const nowMinutes = minutesFromStartOfDay(new Date())
    const scrollTop = Math.max(0, (nowMinutes / 60) * HOUR_HEIGHT_DAY - 200)
    scrollRef.current.scrollTop = scrollTop
  }, [])

  const nowTop = isToday(date) ? (minutesFromStartOfDay(now) / 60) * HOUR_HEIGHT_DAY : -1

  return (
    <div
      ref={scrollRef}
      className="rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 overflow-y-auto"
      style={{ maxHeight: 'calc(100vh - 220px)' }}
    >
      <div className="flex">
        {/* 小时刻度 */}
        <div className="flex-shrink-0 w-12 relative" style={{ height: 24 * HOUR_HEIGHT_DAY }}>
          {Array.from({ length: 24 }, (_, h) => (
            <div
              key={h}
              className="text-xs text-gray-400 text-right pr-2 border-t border-gray-100 dark:border-gray-800"
              style={{ height: HOUR_HEIGHT_DAY, lineHeight: `${HOUR_HEIGHT_DAY}px` }}
            >
              {h === 0 ? '' : `${String(h).padStart(2, '0')}:00`}
            </div>
          ))}
        </div>
        {/* 时间线区域 */}
        <div className="flex-1 relative" style={{ height: 24 * HOUR_HEIGHT_DAY }}>
          {/* 水平网格线 */}
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} className="border-t border-gray-100 dark:border-gray-800" style={{ height: HOUR_HEIGHT_DAY }} />
          ))}
          {/* 条目块 */}
          {layout.map(({ entry, start, end, col, cols }) => {
            const topMin = (start - dayStart) / 60000
            const heightMin = (end - start) / 60000
            const top = (topMin / 60) * HOUR_HEIGHT_DAY
            const height = Math.max((heightMin / 60) * HOUR_HEIGHT_DAY, 18)
            const widthPercent = 100 / cols
            const leftPercent = (col / cols) * 100
            const color = entry.tag?.color ?? '#6d5efc'
            return (
              <button
                key={entry.id}
                onClick={() => onEntryClick(entry)}
                className="absolute rounded-md text-left overflow-hidden hover:z-10 hover:shadow-md transition-shadow"
                style={{
                  top: top + 1,
                  height: height - 2,
                  left: `calc(${leftPercent}% + 2px)`,
                  width: `calc(${widthPercent}% - 4px)`,
                  backgroundColor: `${color}1a`,
                  borderLeft: `3px solid ${color}`,
                }}
              >
                <div className="px-1.5 py-0.5 text-xs font-medium truncate" style={{ color }}>
                  {entry.tag?.name}
                </div>
                {height > 36 && (
                  <div className="px-1.5 text-[10px] text-gray-400">
                    {new Date(entry.startTime).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                    {' - '}
                    {entry.endTime
                      ? new Date(entry.endTime).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
                      : '进行中'}
                  </div>
                )}
                {height > 54 && entry.note && (
                  <div className="px-1.5 text-[10px] text-gray-400 truncate">📝 {entry.note}</div>
                )}
              </button>
            )
          })}
          {/* 现在时间线 */}
          {nowTop >= 0 && (
            <div className="absolute left-0 right-0 z-20 pointer-events-none" style={{ top: nowTop }}>
              <div className="flex items-center">
                <div className="w-2 h-2 rounded-full bg-red-500 -ml-1" />
                <div className="flex-1 h-px bg-red-500" />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ===== 周视图 =====

function WeekView({ weekStart, entries, now, onEntryClick }: {
  weekStart: Date
  entries: TimeEntry[]
  now: Date
  onEntryClick: (e: TimeEntry) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const days = getWeekDays(weekStart)
  const nowTop = (minutesFromStartOfDay(now) / 60) * HOUR_HEIGHT_WEEK

  useEffect(() => {
    if (!scrollRef.current) return
    const nowMinutes = minutesFromStartOfDay(new Date())
    const scrollTop = Math.max(0, (nowMinutes / 60) * HOUR_HEIGHT_WEEK - 200)
    scrollRef.current.scrollTop = scrollTop
  }, [])

  return (
    <div
      ref={scrollRef}
      className="rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 overflow-y-auto"
      style={{ maxHeight: 'calc(100vh - 220px)' }}
    >
      {/* 星期表头 */}
      <div className="flex sticky top-0 z-10 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800">
        <div className="flex-shrink-0 w-10" />
        {days.map((d) => (
          <div key={d.toISOString()} className={`flex-1 text-center py-2 ${isToday(d) ? 'text-brand' : 'text-gray-500'}`}>
            <div className="text-xs">{WEEKDAYS[d.getDay() === 0 ? 6 : d.getDay() - 1]}</div>
            <div className={`text-sm font-semibold ${isToday(d) ? 'bg-brand text-white rounded-full w-6 h-6 mx-auto flex items-center justify-center' : ''}`}>
              {d.getDate()}
            </div>
          </div>
        ))}
      </div>

      <div className="flex">
        {/* 小时刻度 */}
        <div className="flex-shrink-0 w-10 relative" style={{ height: 24 * HOUR_HEIGHT_WEEK }}>
          {Array.from({ length: 24 }, (_, h) => (
            <div
              key={h}
              className="text-[10px] text-gray-400 text-right pr-1 border-t border-gray-100 dark:border-gray-800"
              style={{ height: HOUR_HEIGHT_WEEK, lineHeight: `${HOUR_HEIGHT_WEEK}px` }}
            >
              {h === 0 ? '' : `${h}`}
            </div>
          ))}
        </div>
        {/* 7天列 */}
        {days.map((d) => {
          const dayStart = startOfDay(d).getTime()
          const dayEnd = endOfDay(d).getTime()
          const dayEntries = entries.filter((e) => {
            const es = new Date(e.startTime).getTime()
            const ee = e.endTime ? new Date(e.endTime).getTime() : Date.now()
            // 计时与该天有重叠即显示（支持跨午夜）
            return es < dayEnd && ee > dayStart
          })
          const layout = layoutEntries(dayEntries, dayStart, dayEnd)
          const showNowLine = isToday(d)

          return (
            <div
              key={d.toISOString()}
              className="flex-1 relative border-l border-gray-100 dark:border-gray-800"
              style={{ height: 24 * HOUR_HEIGHT_WEEK }}
            >
              {/* 水平网格线 */}
              {Array.from({ length: 24 }, (_, h) => (
                <div key={h} className="border-t border-gray-100 dark:border-gray-800" style={{ height: HOUR_HEIGHT_WEEK }} />
              ))}
              {/* 条目块 */}
              {layout.map(({ entry, start, end, col, cols }) => {
                const topMin = (start - dayStart) / 60000
                const heightMin = (end - start) / 60000
                const top = (topMin / 60) * HOUR_HEIGHT_WEEK
                const height = Math.max((heightMin / 60) * HOUR_HEIGHT_WEEK, 14)
                const widthPercent = 100 / cols
                const leftPercent = (col / cols) * 100
                const color = entry.tag?.color ?? '#6d5efc'
                return (
                  <button
                    key={entry.id}
                    onClick={() => onEntryClick(entry)}
                    className="absolute rounded text-left overflow-hidden hover:z-10 hover:shadow-md transition-shadow"
                    style={{
                      top: top + 1,
                      height: height - 2,
                      left: `calc(${leftPercent}% + 1px)`,
                      width: `calc(${widthPercent}% - 2px)`,
                      backgroundColor: `${color}1a`,
                      borderLeft: `2px solid ${color}`,
                    }}
                  >
                    {height > 20 && (
                      <div className="px-1 text-[10px] font-medium truncate" style={{ color }}>
                        {entry.tag?.name}
                      </div>
                    )}
                  </button>
                )
              })}
              {/* 现在时间线 */}
              {showNowLine && (
                <div className="absolute left-0 right-0 z-20 pointer-events-none" style={{ top: nowTop }}>
                  <div className="h-px bg-red-500" />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ===== 月视图 =====

function MonthView({ date, entriesByDay, dayTotal, onDayClick }: {
  date: Date
  entriesByDay: Map<string, TimeEntry[]>
  dayTotal: (d: Date) => number
  onDayClick: (d: Date) => void
}) {
  const days = getMonthGrid(date)

  return (
    <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 overflow-hidden">
      {/* 星期表头 */}
      <div className="grid grid-cols-7 border-b border-gray-200 dark:border-gray-800">
        {WEEKDAYS_FULL.map((w) => (
          <div key={w} className="text-center py-2 text-xs text-gray-400 font-medium">{w}</div>
        ))}
      </div>
      {/* 日期网格 */}
      <div className="grid grid-cols-7">
        {days.map((d) => {
          const key = startOfDay(d).toISOString()
          const dayEntries = entriesByDay.get(key) ?? []
          const total = dayTotal(d)
          const inMonth = isSameMonth(d, date)
          const today = isToday(d)

          return (
            <button
              key={d.toISOString()}
              onClick={() => onDayClick(d)}
              className={`min-h-[88px] border-r border-b border-gray-100 dark:border-gray-800 p-1.5 text-left hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors ${!inMonth ? 'opacity-40' : ''}`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className={`text-xs font-medium w-5 h-5 flex items-center justify-center rounded-full ${today ? 'bg-brand text-white' : 'text-gray-600 dark:text-gray-400'}`}>
                  {d.getDate()}
                </span>
                {total > 0 && (
                  <span className="text-[10px] text-gray-400 font-mono">{formatDuration(total)}</span>
                )}
              </div>
              {/* 条目迷你条 */}
              <div className="space-y-0.5">
                {dayEntries.slice(0, 3).map((e) => (
                  <div
                    key={e.id}
                    className="text-[10px] truncate rounded px-1 py-0.5"
                    style={{
                      backgroundColor: `${e.tag?.color ?? '#6d5efc'}1a`,
                      color: e.tag?.color ?? '#6d5efc',
                    }}
                  >
                    {e.tag?.name}
                  </div>
                ))}
                {dayEntries.length > 3 && (
                  <div className="text-[10px] text-gray-400 px-1">+{dayEntries.length - 3} 更多</div>
                )}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ===== 条目详情弹窗 =====

function EntryDetail({ entry, onClose }: {
  entry: TimeEntry
  onClose: () => void
}) {
  const start = new Date(entry.startTime)
  const end = entry.endTime ? new Date(entry.endTime) : new Date()
  const duration = end.getTime() - start.getTime()
  const color = entry.tag?.color ?? '#6d5efc'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 rounded-2xl p-6 w-full max-w-sm mx-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-4">
          <span className="w-3 h-3 rounded-full" style={{ background: color }} />
          <h3 className="text-lg font-semibold" style={{ color }}>{entry.tag?.name}</h3>
          {entry.tag?.category && (
            <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: entry.tag.category.color, color: '#fff' }}>
              {entry.tag.category.name}
            </span>
          )}
        </div>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-400">开始</span>
            <span>{start.toLocaleString('zh-CN', { hour12: false })}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">结束</span>
            <span>{entry.endTime ? end.toLocaleString('zh-CN', { hour12: false }) : '进行中…'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">时长</span>
            <span className="font-mono font-medium">{formatDuration(duration)}</span>
          </div>
          {entry.note && (
            <div className="pt-2 border-t border-gray-100 dark:border-gray-800">
              <div className="text-gray-400 mb-1">备注</div>
              <div>{entry.note}</div>
            </div>
          )}
        </div>
        <button
          onClick={onClose}
          className="mt-6 w-full py-2 rounded-lg text-sm bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700"
        >
          关闭
        </button>
      </div>
    </div>
  )
}

// ===== 动态时间线 (Timeline Section) =====
function TimelineSection() {
  const [days, setDays] = useState<1 | 7 | 30>(7)
  const [memos, setMemos] = useState<Memo[]>([])
  const [loading, setLoading] = useState(false)
  const [previewImage, setPreviewImage] = useState<string | null>(null)
  const [activeAddModalEntry, setActiveAddModalEntry] = useState<TimeEntry | null>(null)
  const [editingMemo, setEditingMemo] = useState<Memo | null>(null)
  const [showNewJournalModal, setShowNewJournalModal] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  const loadMemos = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.memos.list({ days })
      setMemos(data)
    } catch (e) {
      setMemos([])
    } finally {
      setLoading(false)
    }
  }, [days])

  useEffect(() => {
    loadMemos()
  }, [loadMemos])

  // 搜索过滤：只展示日记/随手记，严格排除打点/点记录（type === 'point'）
  const filteredMemos = useMemo(() => {
    const diaryOnlyMemos = memos.filter((m) => m.type !== 'point')
    if (!searchQuery) return diaryOnlyMemos
    const q = searchQuery.toLowerCase()
    return diaryOnlyMemos.filter((m) => {
      const content = m.content?.toLowerCase() ?? ''
      const tagName = (m.tag?.name ?? m.timeEntry?.tag?.name ?? '').toLowerCase()
      return content.includes(q) || tagName.includes(q)
    })
  }, [memos, searchQuery])

  return (
    <div className="mt-8 pt-6 border-t border-gray-200 dark:border-gray-800 space-y-4">
      {/* 标题与切片选择器 */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <h2 className="text-base font-bold flex items-center gap-2">
            <span>📖 动态时间线 · 日记/随手记</span>
          </h2>
          <button
            onClick={() => setShowNewJournalModal(true)}
            className="px-3 py-1 rounded-lg bg-brand text-white text-xs font-medium hover:bg-brand-600 transition-colors flex items-center gap-1 shadow-xs"
          >
            <span>✍️ + 写日记</span>
          </button>
          {/* 搜索框 */}
          <div className="relative">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索日记…"
              className="text-xs border border-gray-200 dark:border-gray-800 rounded-lg pl-7 pr-2 py-1 bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300 w-32 focus:w-44 transition-all focus:outline-none focus:border-brand"
            />
            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-xs">🔍</span>
          </div>
        </div>
        <div className="flex items-center gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-0.5 text-xs font-medium">
          {([1, 7, 30] as const).map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`px-3 py-1 rounded-md transition-colors ${
                days === d
                  ? 'bg-white dark:bg-gray-700 text-brand shadow-sm font-semibold'
                  : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              {d === 1 ? '1天 (今天)' : d === 7 ? '7天 (本周)' : '30天 (本月)'}
            </button>
          ))}
        </div>
      </div>

      {/* 动态卡片时间轴流 */}
      {loading ? (
        <div className="text-center py-8 text-gray-400 text-sm">加载时间线...</div>
      ) : filteredMemos.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 dark:border-gray-800 p-8 text-center text-gray-400 text-sm">
          {searchQuery
            ? '未找到匹配的日记'
            : `近 ${days === 1 ? '1 天' : `${days} 天`} 暂无记事日志。在计时界面点击「📝 记事」即可记录感悟和照片！`}
        </div>
      ) : (
        <div className="relative pl-6 space-y-6 before:absolute before:left-2.5 before:top-2 before:bottom-2 before:w-0.5 before:bg-gray-200 dark:before:bg-gray-800">
          {filteredMemos.map((memo) => {
            const timeStr = new Date(memo.createdAt).toLocaleString('zh-CN', {
              month: 'numeric',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })
            const tagColor = memo.tag?.color ?? memo.timeEntry?.tag?.color ?? '#6d5efc'
            const tagName = memo.tag?.name ?? memo.timeEntry?.tag?.name ?? '随手记'
            const categoryName = memo.tag?.category?.name ?? memo.timeEntry?.tag?.category?.name

            const images = memo.attachments?.filter((a) => a.mimeType.startsWith('image/')) ?? []
            const videos = memo.attachments?.filter((a) => a.mimeType.startsWith('video/')) ?? []

            return (
              <div key={memo.id} className="relative group">
                {/* 时间轴锚点 */}
                <div
                  className="absolute -left-6 top-1.5 w-3 h-3 rounded-full border-2 border-white dark:border-gray-900"
                  style={{ background: tagColor }}
                />

                {/* 内容卡片 */}
                <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 p-4 space-y-3 shadow-sm hover:shadow transition-shadow">
                  {/* 头部：勾稽计时与标签 */}
                  <div className="flex items-center justify-between text-xs text-gray-400 flex-wrap gap-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-gray-700 dark:text-gray-200">{timeStr}</span>
                      <span
                        className="px-2 py-0.5 rounded-full font-medium"
                        style={{ backgroundColor: `${tagColor}20`, color: tagColor }}
                      >
                        {categoryName ? `${categoryName} / ` : ''}{tagName}
                      </span>
                      {memo.timeEntry && (
                        <span className="text-gray-400 bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded">
                          ⏱ 关联计时: {formatDuration(
                            (memo.timeEntry.endTime
                              ? new Date(memo.timeEntry.endTime).getTime()
                              : Date.now()) - new Date(memo.timeEntry.startTime).getTime()
                          )}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setEditingMemo(memo)}
                        className="text-gray-300 hover:text-brand opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        编辑
                      </button>
                      <button
                        onClick={async () => {
                          if (!confirm('确定要删除这条记事吗？')) return
                          await api.memos.remove(memo.id)
                          loadMemos()
                        }}
                        className="text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        删除
                      </button>
                    </div>
                  </div>

                  {/* 文本内容 */}
                  <div className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap leading-relaxed">
                    {memo.content}
                  </div>

                  {/* 图片展示 (网格) */}
                  {images.length > 0 && (
                    <div className={`grid gap-2 ${images.length === 1 ? 'grid-cols-1 max-w-sm' : images.length === 2 ? 'grid-cols-2 max-w-md' : 'grid-cols-3 max-w-lg'}`}>
                      {images.map((img) => (
                        <button
                          key={img.id}
                          type="button"
                          onClick={() => setPreviewImage(resolveUploadUrl(img.path))}
                          className="rounded-lg overflow-hidden border border-gray-100 dark:border-gray-800 bg-gray-100 dark:bg-gray-800 aspect-square group/img relative"
                        >
                          <img
                            src={resolveUploadUrl(img.path)}
                            alt={img.filename}
                            className="w-full h-full object-cover group-hover/img:scale-105 transition-transform"
                          />
                        </button>
                      ))}
                    </div>
                  )}

                  {/* 视频播放器 */}
                  {videos.length > 0 && (
                    <div className="space-y-2 max-w-md pt-1">
                      {videos.map((vid) => (
                        <div key={vid.id} className="rounded-xl overflow-hidden border border-gray-200 dark:border-gray-800 bg-black">
                          <video
                            src={resolveUploadUrl(vid.path)}
                            controls
                            playsInline
                            className="w-full max-h-64 object-contain"
                          />
                          <div className="text-[10px] text-gray-400 px-2 py-1 bg-gray-900 truncate">
                            🎬 {vid.filename}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* 大图全屏预览弹窗 */}
      {previewImage && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => setPreviewImage(null)}
        >
          <img src={previewImage} alt="全屏预览" className="max-w-full max-h-full rounded-lg object-contain" />
        </div>
      )}

      {/* 弹窗添加记事 */}
      {activeAddModalEntry && (
        <MemoCreateModal
          entry={activeAddModalEntry}
          onClose={() => setActiveAddModalEntry(null)}
          onSaved={() => {
            setActiveAddModalEntry(null)
            loadMemos()
          }}
        />
      )}

      {/* 编辑记事弹窗 */}
      {editingMemo && (
        <MemoEditModal
          memo={editingMemo}
          onClose={() => setEditingMemo(null)}
          onSaved={() => {
            setEditingMemo(null)
            loadMemos()
          }}
        />
      )}

      {/* 新建独立日记弹窗 */}
      {showNewJournalModal && (
        <NewJournalModal
          onClose={() => setShowNewJournalModal(false)}
          onSaved={() => {
            setShowNewJournalModal(false)
            loadMemos()
          }}
        />
      )}
    </div>
  )
}

function toLocalInputWithSeconds(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function NewJournalModal({
  onClose,
  onSaved,
}: {
  onClose: () => void
  onSaved: () => void
}) {
  const { tags } = useStore()
  const [content, setContent] = useState('')
  const [tagId, setTagId] = useState<string>('')
  const [memoTime, setMemoTime] = useState(toLocalInputWithSeconds(new Date()))
  const [uploading, setUploading] = useState(false)
  const [attachments, setAttachments] = useState<{ filename: string; path: string; mimeType: string; size: number }[]>([])
  const [error, setError] = useState('')

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return
    setUploading(true)
    setError('')
    try {
      for (let i = 0; i < files.length; i++) {
        const res = await api.memos.upload(files[i])
        setAttachments((prev) => [...prev, res])
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setUploading(false)
    }
  }

  const save = async () => {
    if (!content.trim() && attachments.length === 0) {
      setError('请输入日记内容或上传图片/视频')
      return
    }
    setError('')
    try {
      await api.memos.create({
        content: content.trim() || '（无文字随记）',
        type: 'diary',
        tagId: tagId || undefined,
        createdAt: new Date(memoTime).toISOString(),
        attachments,
      })
      onSaved()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 rounded-2xl p-6 w-full max-w-md mx-4 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold">✍️ 新建日记 / 随手记</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
        </div>

        <div>
          <label className="block text-xs font-semibold text-gray-500 mb-1">日记时间 (精准到秒)</label>
          <DateTimeSecondPicker value={memoTime} onChange={setMemoTime} />
        </div>

        <div>
          <label className="block text-xs font-semibold text-gray-500 mb-1">关联标签 (可选)</label>
          <select value={tagId} onChange={(e) => setTagId(e.target.value)} className="input text-sm">
            <option value="">独立日记 (不绑定标签)</option>
            {tags.map((t) => (
              <option key={t.id} value={t.id}>{t.icon ? `${t.icon} ` : ''}{t.name}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-semibold text-gray-500 mb-1">日记内容 / 感悟与照片</label>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={4}
            placeholder="写下今天的想法、生活随笔、感悟或日志..."
            className="input"
            autoFocus
          />
        </div>

        <div>
          <label className="block text-xs font-semibold text-gray-500 mb-1">图片 / 视频附件</label>
          <input
            type="file"
            accept="image/*,video/*"
            multiple
            onChange={handleFileUpload}
            disabled={uploading}
            className="block w-full text-xs text-gray-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-brand-50 file:text-brand dark:file:bg-brand-900/40 dark:file:text-brand-300 hover:file:bg-brand-100"
          />
          {uploading && <div className="text-xs text-brand mt-1">上传中...</div>}
        </div>

        {attachments.length > 0 && (
          <div className="grid grid-cols-3 gap-2 pt-1">
            {attachments.map((att, idx) => (
              <div key={idx} className="relative rounded-lg overflow-hidden border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800 h-16 flex items-center justify-center">
                {att.mimeType.startsWith('image/') ? (
                  <img src={resolveUploadUrl(att.path)} alt={att.filename} className="w-full h-full object-cover" />
                ) : (
                  <span className="text-sm">🎬 视频</span>
                )}
              </div>
            ))}
          </div>
        )}

        {error && <div className="text-xs text-red-500">{error}</div>}

        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800">
            取消
          </button>
          <button onClick={save} className="px-4 py-2 rounded-lg text-sm bg-brand text-white hover:bg-brand-600 font-medium">
            保存日记
          </button>
        </div>
      </div>
    </div>
  )
}
