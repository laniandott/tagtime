import { useEffect, useState, useMemo, useRef, useCallback } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { formatDuration, useStore, toIsoSafe } from '../store'
import type { TimeEntry, Memo, Todo, LinkedNoteEntry } from '../types'
import { DateTimeSecondPicker } from '../components/DateTimeSecondPicker'
import { CalendarSyncModal } from '../components/CalendarSyncModal'
import { SubscriptionManager } from '../components/SubscriptionManager'
import type { CalendarEvent } from '../types'
import { Solar } from 'lunar-javascript'

// 农历工具：公历转农历
function getLunarText(d: Date): string {
  const solar = Solar.fromDate(d)
  const lunar = solar.getLunar()
  // 初一显示月份，否则显示日期
  if (lunar.getDay() === 1) {
    return lunar.getMonth() > 0 ? `${lunar.getMonth()}月` : `闰${-lunar.getMonth()}月`
  }
  return lunar.getDayInChinese()
}

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

function toLocalInputWithSeconds(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function externalEventRange(event: CalendarEvent): { start: number; end: number } {
  const start = new Date(event.dtstart).getTime()
  const fallbackDuration = event.allday ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000
  const end = event.dtend ? new Date(event.dtend).getTime() : start + fallbackDuration
  return { start, end }
}

function externalEventOverlapsDay(event: CalendarEvent, dayStart: number, dayEnd: number): boolean {
  const { start, end } = externalEventRange(event)
  return Number.isFinite(start) && Number.isFinite(end) && start < dayEnd && end > dayStart
}

function formatExternalEventLabel(event: CalendarEvent): string {
  if (event.allday) return event.summary
  const start = new Date(event.dtstart)
  const startText = start.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  if (!event.dtend) return `${startText} ${event.summary}`
  const end = new Date(event.dtend)
  const endText = end.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  return `${startText}-${endText} ${event.summary}`
}

function activityDate(todo: Todo): Date | null {
  const value = todo.completedAt ?? todo.dueDate
  if (!value) return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

function activityIsOnDay(todo: Todo, day: Date): boolean {
  const date = activityDate(todo)
  return date ? isSameDay(date, day) : false
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
  const { categories } = useStore()
  const [searchParams] = useSearchParams()
  const [view, setView] = useState<'day' | 'week' | 'month'>('month')
  const [currentDate, setCurrentDate] = useState(new Date())
  const [entries, setEntries] = useState<TimeEntry[]>([])
  const [memos, setMemos] = useState<Memo[]>([])
  const [selectedEntry, setSelectedEntry] = useState<TimeEntry | null>(null)
  const [showSyncModal, setShowSyncModal] = useState(false)
  const [quickCreateDefaults, setQuickCreateDefaults] = useState<{ date: Date; startTime?: Date; endTime?: Date } | null>(null)
  const [showSubManager, setShowSubManager] = useState(false)
  const [showFilter, setShowFilter] = useState(false)
  const [selectedCategoryKeys, setSelectedCategoryKeys] = useState<Set<string> | null>(null)
  const [externalEvents, setExternalEvents] = useState<CalendarEvent[]>([])
  const [activities, setActivities] = useState<Todo[]>([])
  const [calendarFilter, setCalendarFilter] = useState<'all' | 'timer' | 'activity'>('all')
  const [dayDetailDate, setDayDetailDate] = useState<Date | null>(null) // 月视图点击日期弹窗
  const [now, setNow] = useState(new Date())
  const [calendarLoading, setCalendarLoading] = useState(false)
  const [calendarError, setCalendarError] = useState('')
  const [dayLinkedNotes, setDayLinkedNotes] = useState<LinkedNoteEntry[]>([])
  const dayNotesRequest = useRef(0)
  const goNote = useNavigate()

  // 日视图回显关联笔记 [[date:YYYY-MM-DD]]
  useEffect(() => {
    const sequence = ++dayNotesRequest.current
    if (view !== 'day') { setDayLinkedNotes([]); return }
    const iso = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}-${String(currentDate.getDate()).padStart(2, '0')}`
    api.notes.linked('date', iso)
      .then((notes) => { if (sequence === dayNotesRequest.current) setDayLinkedNotes(notes) })
      .catch(() => { if (sequence === dayNotesRequest.current) setDayLinkedNotes([]) })
  }, [view, currentDate])
  // 每分钟更新当前时间（用于"现在"指示线）
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60000)
    return () => clearInterval(t)
  }, [])

  // 支持从笔记 [[date:YYYY-MM-DD]] 跳转：定位到指定日期（日视图）
  useEffect(() => {
    const d = searchParams.get('date')
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
      const parts = d.split('-').map(Number)
      setCurrentDate(new Date(parts[0], parts[1] - 1, parts[2]))
      setView('day')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

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

  const allCategoryKeys = useMemo(
    () => new Set([...categories.map((category) => category.id), '_none']),
    [categories],
  )

  // 标签/分类筛选在前端完成，避免切换筛选器时重复请求。
  const visibleEntries = useMemo(() => {
    const categoryEntries = selectedCategoryKeys
      ? entries.filter((entry) => selectedCategoryKeys.has(entry.tag?.categoryId ?? '_none'))
      : entries
    return calendarFilter === 'activity' ? [] : categoryEntries
  }, [entries, selectedCategoryKeys, calendarFilter])

  const visibleActivities = useMemo(() => {
    const categoryActivities = selectedCategoryKeys
      ? activities.filter((todo) => selectedCategoryKeys.has(todo.categoryId ?? '_none'))
      : activities
    return calendarFilter === 'timer' ? [] : categoryActivities
  }, [activities, selectedCategoryKeys, calendarFilter])

  const memosByDay = useMemo(() => {
    const map = new Map<string, Memo[]>()
    for (const memo of memos) {
      const key = startOfDay(new Date(memo.createdAt)).toISOString()
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(memo)
    }
    return map
  }, [memos])

  // 加载当前视图所需的三类数据，并避免快速翻页时旧请求覆盖新页面。
  useEffect(() => {
    let cancelled = false
    setCalendarLoading(true)
    const params = { from: range.from.toISOString(), to: range.to.toISOString() }

    Promise.allSettled([
      api.timer.list(params),
      api.calendars.events(params),
      api.memos.list(params),
      api.todos.list(),
    ]).then(([entryResult, externalResult, memoResult, activityResult]) => {
      if (cancelled) return
      const failures: string[] = []
      if (entryResult.status === 'fulfilled') setEntries(entryResult.value)
      else failures.push('时间记录')
      if (externalResult.status === 'fulfilled') setExternalEvents(externalResult.value)
      else failures.push('外部日历')
      if (memoResult.status === 'fulfilled') setMemos(memoResult.value)
      else failures.push('记事')
      if (activityResult.status === 'fulfilled') setActivities(activityResult.value)
      else failures.push('活动')
      setCalendarError(failures.length ? `${failures.join('、')}加载失败，请稍后重试` : '')
      setCalendarLoading(false)
    })

    return () => { cancelled = true }
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
    const rangeStart = range.from.getTime()
    const rangeEnd = range.to.getTime()
    for (const e of visibleEntries) {
      const rawStart = new Date(e.startTime).getTime()
      const rawEnd = e.endTime ? new Date(e.endTime).getTime() : Date.now()
      if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd) || rawEnd < rangeStart || rawStart > rangeEnd) continue

      // 只遍历当前视图范围内的日期。长时间运行的计时如果从数月前开始，
      // 不应在月视图中把范围外的每一天都展开一次。
      const entryStart = startOfDay(new Date(Math.max(rawStart, rangeStart)))
      const entryEnd = startOfDay(new Date(Math.min(rawEnd, rangeEnd)))
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
  }, [visibleEntries, range.from, range.to])

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
  }, [entriesByDay, now])

  // 当前周期总时长
  const periodTotal = useMemo(() => {
    const rangeStart = range.from.getTime()
    const rangeEnd = range.to.getTime()
    return visibleEntries.reduce((sum, e) => {
      const start = Math.max(new Date(e.startTime).getTime(), rangeStart)
      const end = Math.min(e.endTime ? new Date(e.endTime).getTime() : Date.now(), rangeEnd)
      return sum + Math.max(0, end - start)
    }, 0)
  }, [visibleEntries, range.from, range.to, now])

  const hasCalendarContent = visibleEntries.length > 0 || visibleActivities.length > 0 || externalEvents.length > 0 || memos.length > 0
  const filterCount = selectedCategoryKeys?.size ?? allCategoryKeys.size

  const setQuickCreateForDate = (date: Date, startTime?: Date, endTime?: Date) => {
    setQuickCreateDefaults({ date, startTime, endTime })
  }

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
      {/* 头部：Google Calendar 风格导航栏 */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setQuickCreateForDate(currentDate)}
            className="flex items-center gap-1.5 px-4 py-2 rounded-full bg-brand text-white text-sm font-medium hover:bg-brand-600 transition-colors shadow-sm"
          >
            <span className="text-lg leading-none">+</span>
            <span className="hidden sm:inline">新建</span>
          </button>
          <button
            onClick={() => navigate(-1)}
            className="w-9 h-9 rounded-full flex items-center justify-center hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-300 transition-colors"
          >
            ‹
          </button>
          <button
            onClick={() => navigate(1)}
            className="w-9 h-9 rounded-full flex items-center justify-center hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-300 transition-colors"
          >
            ›
          </button>
          <button
            onClick={() => setCurrentDate(new Date())}
            className="px-4 py-1.5 rounded-full text-sm border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            今天
          </button>
          <h1 className="text-lg sm:text-xl font-semibold ml-2 text-gray-800 dark:text-gray-100 truncate">{title}</h1>
        </div>
        <div className="flex items-center gap-2">
          {periodTotal > 0 && (
            <span className="text-xs text-gray-400 mr-1">
              合计 <span className="font-mono font-medium text-gray-500 dark:text-gray-400">{formatDuration(periodTotal)}</span>
            </span>
          )}
          <div className="flex items-center rounded-full bg-gray-100 dark:bg-gray-800 p-0.5">
            {([['all', '全部'], ['timer', '计时'], ['activity', '活动']] as const).map(([value, label]) => (
              <button
                key={value}
                onClick={() => setCalendarFilter(value)}
                className={`px-2.5 py-1 text-xs rounded-full transition-colors ${
                  calendarFilter === value
                    ? 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-100 shadow-sm'
                    : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="relative">
            <button
              onClick={() => setShowFilter((open) => !open)}
              className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                selectedCategoryKeys ? 'bg-brand-100 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300' : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800'
              }`}
            >
              筛选{selectedCategoryKeys ? ` (${filterCount})` : ''}
            </button>
            {showFilter && (
              <div className="absolute right-0 top-full mt-2 z-30 w-60 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-3 shadow-xl">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold text-gray-600 dark:text-gray-200">显示分类</span>
                  <button onClick={() => setSelectedCategoryKeys(null)} className="text-[10px] text-brand hover:underline">全部</button>
                </div>
                <div className="space-y-1 max-h-52 overflow-y-auto">
                  {categories.map((category) => {
                    const checked = selectedCategoryKeys === null || selectedCategoryKeys.has(category.id)
                    return (
                      <label key={category.id} className="flex items-center gap-2 px-1 py-1 text-xs cursor-pointer">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => setSelectedCategoryKeys((prev) => {
                            const next = new Set(prev ?? allCategoryKeys)
                            if (next.has(category.id)) next.delete(category.id)
                            else next.add(category.id)
                            return next
                          })}
                        />
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: category.color }} />
                        <span className="truncate">{category.name}</span>
                      </label>
                    )
                  })}
                  <label className="flex items-center gap-2 px-1 py-1 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedCategoryKeys === null || selectedCategoryKeys.has('_none')}
                      onChange={() => setSelectedCategoryKeys((prev) => {
                        const next = new Set(prev ?? allCategoryKeys)
                        if (next.has('_none')) next.delete('_none')
                        else next.add('_none')
                        return next
                      })}
                    />
                    <span className="w-2 h-2 rounded-full bg-gray-400" />
                    <span>未分类</span>
                  </label>
                </div>
                <div className="flex justify-between mt-2 pt-2 border-t border-gray-100 dark:border-gray-800">
                  <button onClick={() => setSelectedCategoryKeys(new Set())} className="text-[10px] text-gray-400 hover:text-red-500">全部取消</button>
                  <button onClick={() => setShowFilter(false)} className="text-[10px] text-brand hover:underline">完成</button>
                </div>
              </div>
            )}
          </div>
          <div className="flex bg-gray-100 dark:bg-gray-800 rounded-full p-0.5">
            {(['day', 'week', 'month'] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`px-4 py-1.5 rounded-full text-sm font-medium transition-all duration-200 ${
                  view === v
                    ? 'bg-white dark:bg-gray-700 text-brand shadow-sm'
                    : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                {v === 'day' ? '日' : v === 'week' ? '周' : '月'}
              </button>
            ))}
          </div>
          <button
            onClick={() => setShowSyncModal(true)}
            className="w-9 h-9 rounded-full flex items-center justify-center hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500 transition-colors"
            title="日历同步 (iCalendar)"
          >
            🗓️
          </button>
          <button
            onClick={() => setShowSubManager(true)}
            className="w-9 h-9 rounded-full flex items-center justify-center hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500 transition-colors"
            title="外部日历订阅管理"
          >
            📡
          </button>
        </div>
      </div>

      {/* 日历主体 */}
      {calendarError && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300">{calendarError}</div>}
      {calendarLoading && !hasCalendarContent ? (
        <div className="rounded-2xl border border-gray-200 dark:border-gray-800 p-12 text-center text-gray-400">加载日历中...</div>
      ) : !hasCalendarContent ? (
        <div className="rounded-2xl border-2 border-dashed border-gray-300 dark:border-gray-700 p-12 text-center text-gray-400">
          <div className="text-4xl mb-2">📅</div>
          <div>该时段暂无时间记录</div>
        </div>
      ) : view === 'day' ? (
        <DayView
          date={currentDate}
          entries={visibleEntries}
          activities={visibleActivities}
          dayMemos={memosByDay.get(startOfDay(currentDate).toISOString()) ?? []}
          externalEvents={externalEvents}
          now={now}
          onEntryClick={setSelectedEntry}
          onCreate={(start, end) => setQuickCreateForDate(start, start, end)}
          linkedNotes={dayLinkedNotes}
          onOpenNote={(id) => goNote(`/notes/${id}`)}
        />
      ) : view === 'week' ? (
        <WeekView
          weekStart={startOfWeek(currentDate)}
          selectedDate={currentDate}
          entries={visibleEntries}
          activities={visibleActivities}
          memosByDay={memosByDay}
          externalEvents={externalEvents}
          now={now}
          dayTotal={dayTotal}
          onEntryClick={setSelectedEntry}
        />
      ) : (
        <MonthView
          date={currentDate}
           entriesByDay={entriesByDay}
           activities={visibleActivities}
           memosByDay={memosByDay}
          externalEvents={externalEvents}
          dayTotal={dayTotal}
          onDayClick={(d) => setDayDetailDate(d)}
        />
      )}

      {/* 条目详情弹窗 */}
      {selectedEntry && (
        <EntryDetail
          entry={selectedEntry}
          onClose={() => setSelectedEntry(null)}
          onChanged={async () => {
            const params = { from: range.from.toISOString(), to: range.to.toISOString() }
            const [nextEntries, nextMemos] = await Promise.all([api.timer.list(params), api.memos.list(params)])
            setEntries(nextEntries)
            setMemos(nextMemos)
            setCalendarError('')
            setSelectedEntry(null)
          }}
        />
      )}

      {/* 日历同步弹窗 */}
      {showSyncModal && <CalendarSyncModal onClose={() => setShowSyncModal(false)} />}

      {/* 快速创建计时弹窗 */}
      {quickCreateDefaults && (
        <QuickCreateModal
          defaultDate={quickCreateDefaults.date}
          defaultStartTime={quickCreateDefaults.startTime}
          defaultEndTime={quickCreateDefaults.endTime}
          onClose={() => setQuickCreateDefaults(null)}
          onSaved={() => {
            setQuickCreateDefaults(null)
            api.timer.list({ from: range.from.toISOString(), to: range.to.toISOString() })
              .then((nextEntries) => { setEntries(nextEntries); setCalendarError('') })
              .catch((err) => setCalendarError(err instanceof Error ? err.message : '刷新时间记录失败'))
          }}
        />
      )}

      {/* 外部日历订阅管理弹窗 */}
      {showSubManager && <SubscriptionManager onClose={() => {
        setShowSubManager(false)
        api.calendars.events({ from: range.from.toISOString(), to: range.to.toISOString() })
          .then((nextEvents) => { setExternalEvents(nextEvents); setCalendarError('') })
          .catch((err) => setCalendarError(err instanceof Error ? err.message : '刷新外部日历失败'))
      }} />}

      {/* 月视图点击日期详情弹窗 */}
      {dayDetailDate && (
        <DayDetailPopup
          date={dayDetailDate}
          entries={visibleEntries}
          activities={visibleActivities}
          dayMemos={memosByDay.get(startOfDay(dayDetailDate).toISOString()) ?? []}
          externalEvents={externalEvents}
          onClose={() => setDayDetailDate(null)}
          onEntryClick={(e) => { setDayDetailDate(null); setSelectedEntry(e) }}
        />
      )}

    </div>
  )
}

// ===== 日视图 =====

function DayView({ date, entries, activities, dayMemos, externalEvents, now, onEntryClick, onCreate, linkedNotes = [], onOpenNote }: {
  date: Date
  entries: TimeEntry[]
  activities: Todo[]
  dayMemos: Memo[]
  externalEvents: CalendarEvent[]
  now: Date
  onEntryClick: (e: TimeEntry) => void
  onCreate: (start: Date, end: Date) => void
  linkedNotes?: LinkedNoteEntry[]
  onOpenNote?: (id: string) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const dayStart = startOfDay(date).getTime()
  const dayEnd = endOfDay(date).getTime()
  const layout = layoutEntries(entries, dayStart, dayEnd)
  const countEntries = entries.filter((entry) => entry.tag?.trackType === 'count' && isSameDay(new Date(entry.startTime), date))
  const dayActivities = activities.filter((todo) => activityIsOnDay(todo, date))
  const topExternal = externalEvents.filter((event) => externalEventOverlapsDay(event, dayStart, dayEnd))
  const uniqueTopExternal = topExternal.filter((event, index, list) => list.findIndex((item) => item.summary === event.summary) === index)

  // 自动滚动到当前时间附近
  useEffect(() => {
    if (!scrollRef.current) return
    const nowMinutes = minutesFromStartOfDay(new Date())
    const scrollTop = Math.max(0, (nowMinutes / 60) * HOUR_HEIGHT_DAY - 200)
    scrollRef.current.scrollTop = scrollTop
  }, [])

  const nowTop = isToday(date) ? (minutesFromStartOfDay(now) / 60) * HOUR_HEIGHT_DAY : -1

  const handleTimelineDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button')) return
    const rect = event.currentTarget.getBoundingClientRect()
    const scrollTop = scrollRef.current?.scrollTop ?? 0
    const rawMinutes = ((event.clientY - rect.top + scrollTop) / HOUR_HEIGHT_DAY) * 60
    const minutes = Math.min(23 * 60 + 45, Math.max(0, Math.round(rawMinutes / 15) * 15))
    const start = new Date(date)
    start.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0)
    const end = new Date(start)
    end.setMinutes(end.getMinutes() + 60)
    onCreate(start, end)
  }

  return (
    <div
      ref={scrollRef}
      className="rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 overflow-y-auto"
      style={{ maxHeight: 'calc(100vh - 180px)' }}
    >
      {/* 笔记回显：挂靠到本日期的 [[date:...]] 笔记 */}
      {linkedNotes.length > 0 && (
        <div className="flex items-center flex-wrap gap-1 px-2 py-1 border-b border-gray-200 dark:border-gray-800">
          <span className="text-[10px] font-semibold text-gray-400 mr-1">📝 关联笔记</span>
          {linkedNotes.map((n) => (
            <button
              key={n.id}
              onClick={() => onOpenNote?.(n.id)}
              className="text-[11px] text-brand hover:underline bg-brand/5 rounded px-1.5 py-0.5 truncate max-w-[180px]"
              title={n.title}
            >
              {n.title}
            </button>
          ))}
        </div>
      )}
      {/* 外部 ICS 事件和次数打卡栏，避免占用时间轴 */}
      {(dayActivities.length > 0 || topExternal.length > 0 || countEntries.length > 0) && (
        <div className="flex border-b border-gray-200 dark:border-gray-800 px-2 py-1 gap-1 flex-wrap">
          {dayActivities.map((todo) => (
            <div
              key={todo.id}
              className={`text-[10px] font-semibold rounded px-2 py-0.5 border ${todo.status === 'done' ? 'line-through opacity-60' : ''}`}
              style={{ color: todo.tag?.color ?? todo.category?.color ?? '#6d5efc', borderColor: todo.tag?.color ?? todo.category?.color ?? '#6d5efc', backgroundColor: `${todo.tag?.color ?? todo.category?.color ?? '#6d5efc'}12` }}
              title={todo.lateReason ?? undefined}
            >
              ◆ {todo.title}
            </div>
          ))}
          {countEntries.map((entry) => (
            <button
              key={entry.id}
              onClick={() => onEntryClick(entry)}
              className="text-[10px] font-semibold rounded px-2 py-0.5 border border-dashed"
              style={{ color: entry.tag?.color ?? '#6d5efc', borderColor: entry.tag?.color ?? '#6d5efc', backgroundColor: `${entry.tag?.color ?? '#6d5efc'}12` }}
            >
              ● {entry.tag?.name}
            </button>
          ))}
          {uniqueTopExternal.map((event) => {
            const color = event.subscription?.color ?? '#2ecc71'
            return (
              <div key={event.id} className="text-[10px] font-semibold text-white rounded px-2 py-0.5" style={{ backgroundColor: color }} title={event.summary}>
                {formatExternalEventLabel(event)}
              </div>
            )
          })}
        </div>
      )}

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
        <div className="flex-1 relative" style={{ height: 24 * HOUR_HEIGHT_DAY }} onDoubleClick={handleTimelineDoubleClick}>
          {/* 水平网格线 */}
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} className="border-t border-gray-100 dark:border-gray-800" style={{ height: HOUR_HEIGHT_DAY }} />
          ))}
          {/* 条目块 */}
          {layout.map(({ entry, start, end, col, cols }) => {
            const topMin = (start - dayStart) / 60000
            const heightMin = (end - start) / 60000
            const top = (topMin / 60) * HOUR_HEIGHT_DAY
            const height = Math.max((heightMin / 60) * HOUR_HEIGHT_DAY, 20)
            const widthPercent = 100 / cols
            const leftPercent = (col / cols) * 100
            const color = entry.tag?.color ?? '#6d5efc'
            const hasMemos = entry.memos && entry.memos.length > 0
            return (
              <button
                key={entry.id}
                onClick={() => onEntryClick(entry)}
                className="absolute z-[1] rounded-lg text-left overflow-hidden hover:z-10 hover:shadow-md transition-all duration-150 group"
                style={{
                  top: top + 1,
                  height: height - 2,
                  left: `calc(${leftPercent}% + 2px)`,
                  width: `calc(${widthPercent}% - 4px)`,
                  backgroundColor: `${color}15`,
                  borderLeft: entry.dismissed ? '2px solid rgb(156 163 175)' : entry.resumedFromId ? `2px solid ${color}` : `3px solid ${color}`,
                }}
              >
                <div className="px-2 py-0.5 text-xs font-semibold truncate" style={{ color }}>
                  {entry.tag?.name}
                </div>
                {height > 32 && (
                  <div className="px-2 text-[10px] text-gray-400 flex items-center gap-1">
                    <span>
                      {new Date(entry.startTime).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                      {' - '}
                      {entry.endTime
                        ? new Date(entry.endTime).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
                        : '进行中'}
                    </span>
                    {hasMemos && <span title={`${entry.memos!.length} 条记事`}>📝</span>}
                  </div>
                )}
                {height > 50 && entry.note && (
                  <div className="px-2 text-[10px] text-gray-400 truncate">{entry.note}</div>
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
      {dayMemos.length > 0 && (
        <div className="border-t border-gray-200 dark:border-gray-800 px-4 py-3">
          <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-2">📝 当日记事 ({dayMemos.length})</div>
          <div className="space-y-1">
            {dayMemos.slice(0, 8).map((memo) => (
              <div key={memo.id} className="text-xs text-gray-600 dark:text-gray-300 truncate">
                {new Date(memo.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} · {memo.content}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ===== 周视图 =====

function WeekView({ weekStart, selectedDate, entries, activities, memosByDay, externalEvents, now, dayTotal, onEntryClick }: {
  weekStart: Date
  selectedDate: Date
  entries: TimeEntry[]
  activities: Todo[]
  memosByDay: Map<string, Memo[]>
  externalEvents: CalendarEvent[]
  now: Date
  dayTotal: (d: Date) => number
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
      style={{ maxHeight: 'calc(100vh - 180px)' }}
    >
      {/* 星期表头 */}
      <div className="flex sticky top-0 z-10 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800">
        <div className="flex-shrink-0 w-10" />
        {days.map((d) => (
          <div key={d.toISOString()} className={`flex-1 text-center py-2 ${isToday(d) ? 'text-brand' : 'text-gray-500'}`}>
            <div className="text-xs">{WEEKDAYS[d.getDay() === 0 ? 6 : d.getDay() - 1]}</div>
            <div className={`text-sm font-semibold w-6 h-6 mx-auto flex items-center justify-center rounded-full ${
              isToday(d)
                ? 'bg-brand text-white'
                : isSameDay(d, selectedDate)
                  ? 'border border-dashed border-brand text-brand'
                  : ''
            }`}>
              {d.getDate()}
            </div>
          </div>
        ))}
      </div>

      {/* 外部 ICS 事件栏（所有事件均置于时间轴顶部） */}
      {(() => {
        const hasTopContent = days.some((d) => {
          const dS = startOfDay(d).getTime()
          const dE = endOfDay(d).getTime()
          const hasExternal = externalEvents.some((ev) => externalEventOverlapsDay(ev, dS, dE))
          const hasCount = entries.some((entry) => entry.tag?.trackType === 'count' && isSameDay(new Date(entry.startTime), d))
          const hasActivities = activities.some((todo) => activityIsOnDay(todo, d))
          return hasExternal || hasCount || hasActivities
        })
        if (!hasTopContent) return null
        return (
          <div className="flex border-b border-gray-200 dark:border-gray-800">
            <div className="flex-shrink-0 w-10" />
            {days.map((d) => {
              const dS = startOfDay(d).getTime()
              const dE = endOfDay(d).getTime()
              const dayExt = externalEvents.filter((ev) => externalEventOverlapsDay(ev, dS, dE))
              const countEntries = entries.filter((entry) => entry.tag?.trackType === 'count' && isSameDay(new Date(entry.startTime), d))
              const dayActivities = activities.filter((todo) => activityIsOnDay(todo, d))
              const seen = new Set<string>()
              const unique = dayExt.filter((e) => { if (seen.has(e.summary)) return false; seen.add(e.summary); return true })
              return (
                <div key={d.toISOString()} className="flex-1 min-h-[24px] px-0.5 py-0.5 space-y-0.5">
                  {dayActivities.slice(0, 2).map((todo) => (
                    <div
                      key={todo.id}
                      className={`text-[9px] font-semibold rounded px-1 py-0.5 border truncate ${todo.status === 'done' ? 'line-through opacity-60' : ''}`}
                      style={{ color: todo.tag?.color ?? todo.category?.color ?? '#6d5efc', borderColor: todo.tag?.color ?? todo.category?.color ?? '#6d5efc', backgroundColor: `${todo.tag?.color ?? todo.category?.color ?? '#6d5efc'}12` }}
                      title={todo.title}
                    >
                      ◆ {todo.title}
                    </div>
                  ))}
                  {countEntries.slice(0, 2).map((entry) => (
                    <button
                      key={entry.id}
                      onClick={() => onEntryClick(entry)}
                      className="w-full text-left text-[9px] font-semibold rounded px-1 py-0.5 border border-dashed truncate"
                      style={{ color: entry.tag?.color ?? '#6d5efc', borderColor: entry.tag?.color ?? '#6d5efc', backgroundColor: `${entry.tag?.color ?? '#6d5efc'}12` }}
                    >
                      ● {entry.tag?.name}
                    </button>
                  ))}
                  {unique.slice(0, 2).map((ev) => {
                    const color = ev.subscription?.color ?? '#2ecc71'
                    return (
                      <div
                        key={ev.id}
                        className="text-[9px] font-semibold text-white rounded px-1 py-0.5 truncate leading-tight"
                        style={{ backgroundColor: color }}
                        title={ev.summary}
                      >
                        {formatExternalEventLabel(ev)}
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        )
      })()}

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
                const height = Math.max((heightMin / 60) * HOUR_HEIGHT_WEEK, 16)
                const widthPercent = 100 / cols
                const leftPercent = (col / cols) * 100
                const color = entry.tag?.color ?? '#6d5efc'
                const hasMemos = entry.memos && entry.memos.length > 0
                return (
                  <button
                    key={entry.id}
                    onClick={() => onEntryClick(entry)}
                    className="absolute z-[1] rounded-md text-left overflow-hidden hover:z-10 hover:shadow-md transition-all duration-150"
                    style={{
                      top: top + 1,
                      height: height - 2,
                      left: `calc(${leftPercent}% + 1px)`,
                      width: `calc(${widthPercent}% - 2px)`,
                      backgroundColor: `${color}15`,
                      borderLeft: entry.dismissed ? '2px solid rgb(156 163 175)' : entry.resumedFromId ? `2px solid ${color}` : `2.5px solid ${color}`,
                    }}
                  >
                    {height > 18 && (
                      <div className="px-1.5 text-[10px] font-semibold truncate flex items-center gap-0.5" style={{ color }}>
                        {entry.tag?.name}
                        {hasMemos && <span className="text-[8px]">📝</span>}
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
      <div className="flex border-t border-gray-200 dark:border-gray-800 bg-gray-50/60 dark:bg-gray-800/30">
        <div className="flex-shrink-0 w-10" />
        {days.map((d) => {
          const dayMemos = memosByDay.get(startOfDay(d).toISOString()) ?? []
          const total = dayTotal(d)
          return (
            <div key={d.toISOString()} className="flex-1 min-w-0 px-1 py-1 text-center text-[9px] text-gray-400 truncate">
              {total > 0 && <span className="font-mono">{formatDuration(total)}</span>}
              {dayMemos.length > 0 && <span className="ml-1">📝{dayMemos.length}</span>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ===== 月视图 =====

function MonthView({ date, entriesByDay, activities, memosByDay, externalEvents, dayTotal, onDayClick }: {
  date: Date
  entriesByDay: Map<string, TimeEntry[]>
  activities: Todo[]
  memosByDay: Map<string, Memo[]>
  externalEvents: CalendarEvent[]
  dayTotal: (d: Date) => number
  onDayClick: (d: Date) => void
}) {
  const days = getMonthGrid(date)

  const getUniqueColors = (dayEntries: TimeEntry[]): string[] => {
    const seen = new Set<string>()
    const colors: string[] = []
    for (const e of dayEntries) {
      const c = e.tag?.color ?? '#6d5efc'
      if (!seen.has(c)) { seen.add(c); colors.push(c) }
    }
    return colors
  }

  return (
    <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 overflow-hidden shadow-sm">
      <div className="grid grid-cols-7 border-b border-gray-200 dark:border-gray-800">
        {WEEKDAYS_FULL.map((w) => (
          <div key={w} className="text-center py-2 text-xs text-gray-400 font-medium">{w}</div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {days.map((d) => {
          const key = startOfDay(d).toISOString()
          const dayEntries = entriesByDay.get(key) ?? []
          const dayActivities = activities.filter((todo) => activityIsOnDay(todo, d))
          const total = dayTotal(d)
          const dayMemos = memosByDay.get(key) ?? []
          const inMonth = isSameMonth(d, date)
          const today = isToday(d)
          const uniqueColors = getUniqueColors(dayEntries)

          return (
            <button
              key={d.toISOString()}
              onClick={() => onDayClick(d)}
              className={`min-h-[100px] border-r border-b border-gray-100 dark:border-gray-800 p-1.5 text-left hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors group ${!inMonth ? 'opacity-30' : ''}`}
            >
              <div className="flex items-center justify-between mb-0.5">
                <div className="flex items-center gap-1">
                  <span className={`text-xs font-semibold w-6 h-6 flex items-center justify-center rounded-full transition-colors ${
                    today
                      ? 'bg-brand text-white'
                      : 'text-gray-600 dark:text-gray-400 group-hover:bg-gray-200 dark:group-hover:bg-gray-700'
                  }`}>
                    {d.getDate()}
                  </span>
                  <span className="text-[9px] text-gray-400">{getLunarText(d)}</span>
                </div>
                {total > 0 && (
                  <span className="text-[10px] text-gray-400 font-mono">{formatDuration(total)}</span>
                )}
              </div>
              {uniqueColors.length > 0 && (
                <div className="flex items-center gap-0.5 mb-1 flex-wrap">
                  {uniqueColors.slice(0, 6).map((c, i) => (
                    <span key={i} className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: c }} />
                  ))}
                </div>
              )}
              {dayActivities.length > 0 && (
                <div className="space-y-px mb-1">
                  {dayActivities.slice(0, 2).map((todo) => {
                    const color = todo.tag?.color ?? todo.category?.color ?? '#6d5efc'
                    return (
                      <div
                        key={todo.id}
                        className={`text-[9px] truncate rounded px-1 py-px leading-tight border ${todo.status === 'done' ? 'line-through opacity-60' : ''}`}
                        style={{ color, borderColor: `${color}55`, backgroundColor: `${color}12` }}
                        title={todo.title}
                      >
                        ◆ {todo.title}
                      </div>
                    )
                  })}
                  {dayActivities.length > 2 && <div className="text-[8px] text-gray-400 px-1">+{dayActivities.length - 2} 个活动</div>}
                </div>
              )}
              {/* 全天外部事件 — 彩色横条 banner */}
              {(() => {
                const dayExtStart = startOfDay(d).getTime()
                const dayExtEnd = endOfDay(d).getTime()
                const dayExt = externalEvents.filter((ev) => externalEventOverlapsDay(ev, dayExtStart, dayExtEnd))
                if (dayExt.length === 0) return null
                // 去重：同名事件只显示一个
                const seen = new Set<string>()
                const unique = dayExt.filter((e) => { if (seen.has(e.summary)) return false; seen.add(e.summary); return true })
                return (
                  <div className="space-y-0.5 mb-1">
                    {unique.slice(0, 2).map((ev) => {
                      const color = ev.subscription?.color ?? '#2ecc71'
                      return (
                        <div
                          key={ev.id}
                          className="text-[9px] font-semibold text-white rounded px-1.5 py-0.5 truncate leading-tight"
                          style={{ backgroundColor: color }}
                          title={ev.summary}
                        >
                          {formatExternalEventLabel(ev)}
                        </div>
                      )
                    })}
                    {unique.length > 2 && (
                      <div className="text-[8px] text-gray-400 px-1">+{unique.length - 2} 更多</div>
                    )}
                  </div>
                )
              })()}
              <div className="space-y-px">
                {dayEntries.slice(0, 3).map((e) => (
                  <div
                    key={e.id}
                    className="text-[9px] truncate rounded px-1 py-px leading-tight font-medium"
                    style={{
                      backgroundColor: `${e.tag?.color ?? '#6d5efc'}18`,
                      color: e.tag?.color ?? '#6d5efc',
                    }}
                  >
                    {e.tag?.name}
                  </div>
                ))}
                {dayEntries.length > 3 && (
                  <div className="text-[9px] text-gray-400 px-1">+{dayEntries.length - 3}</div>
                )}
              </div>
              {dayMemos.length > 0 && (
                <div className="text-[9px] text-gray-500 dark:text-gray-400 mt-1 truncate">📝 {dayMemos.length}</div>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ===== 条目详情弹窗 =====

function EntryDetail({ entry, onClose, onChanged }: {
  entry: TimeEntry
  onClose: () => void
  onChanged: () => void | Promise<void>
}) {
  const start = new Date(entry.startTime)
  const end = entry.endTime ? new Date(entry.endTime) : new Date()
  const duration = end.getTime() - start.getTime()
  const color = entry.tag?.color ?? '#6d5efc'
  const memos = entry.memos ?? []
  const [editing, setEditing] = useState(false)
  const [editStart, setEditStart] = useState(toLocalInputWithSeconds(start))
  const [editEnd, setEditEnd] = useState(entry.endTime ? toLocalInputWithSeconds(new Date(entry.endTime)) : '')
  const [editNote, setEditNote] = useState(entry.note ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const saveEdit = async () => {
    const startIso = toIsoSafe(editStart)
    const endIso = editEnd ? toIsoSafe(editEnd) : null
    if (!startIso || (editEnd && !endIso)) {
      setError('请选择有效的起止时间')
      return
    }
    if (endIso && new Date(endIso) <= new Date(startIso)) {
      setError('结束时间必须晚于开始时间')
      return
    }
    setSaving(true)
    setError('')
    try {
      await api.timer.update(entry.id, { startTime: startIso, endTime: endIso, note: editNote })
      await onChanged()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const removeEntry = async () => {
    if (!confirm('确定要删除这条时间记录吗？')) return
    setSaving(true)
    try {
      await api.timer.remove(entry.id)
      await onChanged()
    } catch (err) {
      setError((err as Error).message)
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 rounded-2xl p-6 w-full max-w-sm mx-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2.5 mb-5">
          <span className="w-4 h-4 rounded-full flex-shrink-0" style={{ background: color }} />
          <div className="min-w-0">
            <h3 className="text-lg font-bold truncate" style={{ color }}>{entry.tag?.name}</h3>
            {entry.tag?.category && (
              <span className="text-[10px] px-2 py-0.5 rounded-full inline-block mt-0.5" style={{ background: `${entry.tag.category.color}20`, color: entry.tag.category.color }}>
                {entry.tag.category.name}
              </span>
            )}
          </div>
        </div>
        {editing ? (
          <div className="space-y-3 mb-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1">开始时间</label>
              <DateTimeSecondPicker value={editStart} onChange={setEditStart} />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">结束时间（留空表示进行中）</label>
              <DateTimeSecondPicker value={editEnd} onChange={setEditEnd} />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">备注</label>
              <textarea value={editNote} onChange={(event) => setEditNote(event.target.value)} rows={3} className="input text-sm" />
            </div>
          </div>
        ) : (
          <div className="space-y-2.5 text-sm mb-4">
          <div className="flex justify-between items-center">
            <span className="text-gray-400 text-xs">开始</span>
            <span className="text-gray-700 dark:text-gray-200">{start.toLocaleString('zh-CN', { hour12: false })}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-gray-400 text-xs">结束</span>
            <span className="text-gray-700 dark:text-gray-200">{entry.endTime ? end.toLocaleString('zh-CN', { hour12: false }) : <span className="text-brand animate-pulse">进行中…</span>}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-gray-400 text-xs">时长</span>
            <span className="font-mono font-semibold text-brand">{formatDuration(duration)}</span>
          </div>
          {entry.todo && (
            <div className="flex justify-between items-center">
              <span className="text-gray-400 text-xs">关联待办</span>
              <span className="text-gray-700 dark:text-gray-200 text-xs truncate max-w-[180px]">✅ {entry.todo.title}</span>
            </div>
          )}
          {entry.note && (
            <div className="pt-2 border-t border-gray-100 dark:border-gray-800">
              <div className="text-gray-400 text-xs mb-1">备注</div>
              <div className="text-gray-700 dark:text-gray-200 text-sm leading-relaxed">{entry.note}</div>
            </div>
          )}
          </div>
        )}
        {memos.length > 0 && (
          <div className="border-t border-gray-100 dark:border-gray-800 pt-3 mb-4">
            <div className="text-xs text-gray-400 mb-2">📖 关联记事 ({memos.length})</div>
            <div className="space-y-2 max-h-40 overflow-y-auto">
              {memos.slice(0, 5).map((m) => (
                <div key={m.id} className="text-xs text-gray-600 dark:text-gray-300 bg-gray-50 dark:bg-gray-800/50 rounded-lg px-3 py-2 leading-relaxed">
                  <span className="text-gray-400">{new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
                  <span className="mx-1">·</span>
                  <span className="line-clamp-2">{m.content}</span>
                </div>
              ))}
              {memos.length > 5 && <div className="text-[10px] text-gray-400 text-center">…还有 {memos.length - 5} 条</div>}
            </div>
          </div>
        )}
        {error && <div className="text-xs text-red-500 mb-3">{error}</div>}
        <div className="flex gap-2">
          {editing ? (
            <>
              <button onClick={() => { setEditing(false); setError('') }} className="flex-1 py-2.5 rounded-xl text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800">取消</button>
              <button onClick={saveEdit} disabled={saving} className="flex-1 py-2.5 rounded-xl text-sm font-medium bg-brand text-white hover:bg-brand-600 disabled:opacity-50">{saving ? '保存中...' : '保存修改'}</button>
            </>
          ) : (
            <>
              <button onClick={onClose} className="flex-1 py-2.5 rounded-xl text-sm font-medium bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors">关闭</button>
              <button onClick={() => setEditing(true)} className="px-3 py-2.5 rounded-xl text-sm text-brand hover:bg-brand-50 dark:hover:bg-brand-900/30">编辑</button>
              <button onClick={removeEntry} disabled={saving} className="px-3 py-2.5 rounded-xl text-sm text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50">删除</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ===== 快速创建计时弹窗 =====

function QuickCreateModal({ defaultDate, defaultStartTime, defaultEndTime, onClose, onSaved }: {
  defaultDate: Date
  defaultStartTime?: Date
  defaultEndTime?: Date
  onClose: () => void
  onSaved: () => void
}) {
  const { tags, categories } = useStore()
  const [todos, setTodos] = useState<Todo[]>([])
  const [tagId, setTagId] = useState<string>('')
  const [todoId, setTodoId] = useState<string>('')
  const [note, setNote] = useState('')
  const initialStartTime = defaultStartTime ?? (() => {
    const date = new Date(defaultDate)
    if (isSameDay(date, new Date())) return new Date()
    date.setHours(9, 0, 0, 0)
    return date
  })()
  const [startTime, setStartTime] = useState(toLocalInputWithSeconds(initialStartTime))
  const [endTime, setEndTime] = useState(defaultEndTime ? toLocalInputWithSeconds(defaultEndTime) : '')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api.todos.list({ status: 'pending' }).then(setTodos).catch(() => setTodos([]))
  }, [])

  const groupedTags = useMemo(() => {
    const groups = new Map<string, { category: typeof categories[0] | null; tags: typeof tags }>()
    for (const t of tags) {
      const catId = t.categoryId ?? '_none'
      if (!groups.has(catId)) {
        const cat = categories.find((c) => c.id === t.categoryId) ?? null
        groups.set(catId, { category: cat, tags: [] })
      }
      groups.get(catId)!.tags.push(t)
    }
    return Array.from(groups.values())
  }, [tags, categories])

  const save = async () => {
    if (!tagId) { setError('请选择标签'); return }
    const startIso = toIsoSafe(startTime)
    if (!startIso) { setError('请选择有效时间'); return }
    setSaving(true)
    setError('')
    try {
      if (endTime) {
        const endIso = toIsoSafe(endTime)
        if (!endIso) { setError('结束时间无效'); setSaving(false); return }
        await api.timer.manual({ tagId, startTime: startIso, endTime: endIso, note: note || undefined, todoId: todoId || undefined })
      } else {
        await api.timer.start({ tagId, note: note || undefined, todoId: todoId || undefined })
      }
      onSaved()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 rounded-2xl p-6 w-full max-w-md mx-4 shadow-xl space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold">⚡ 快速创建</h3>
          <button onClick={onClose} className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400 transition-colors">✕</button>
        </div>

        <div>
          <label className="block text-xs font-semibold text-gray-500 mb-1.5">标签 *</label>
          <div className="max-h-40 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded-xl p-2 space-y-2">
            {groupedTags.map((g) => (
              <div key={g.category?.id ?? '_none'}>
                {g.category && (
                  <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider px-1 mb-1">
                    {g.category.icon ? `${g.category.icon} ` : ''}{g.category.name}
                  </div>
                )}
                <div className="flex flex-wrap gap-1">
                  {g.tags.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => setTagId(t.id)}
                      className={`px-2.5 py-1 rounded-full text-xs font-medium transition-all duration-150 ${
                        tagId === t.id
                          ? 'ring-2 ring-offset-1 ring-offset-white dark:ring-offset-gray-900 shadow-sm'
                          : 'hover:shadow-sm'
                      }`}
                      style={{
                        backgroundColor: `${t.color}18`,
                        color: t.color,
                        ...(tagId === t.id ? { boxShadow: `0 0 0 2px ${t.color}40` } : {}),
                      }}
                    >
                      {t.icon ? `${t.icon} ` : ''}{t.name}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-xs font-semibold text-gray-500 mb-1">开始时间</label>
          <DateTimeSecondPicker value={startTime} onChange={setStartTime} />
        </div>

        <div>
          <label className="block text-xs font-semibold text-gray-500 mb-1">
            结束时间 <span className="text-gray-400 font-normal">（留空 = 开始计时）</span>
          </label>
          <DateTimeSecondPicker value={endTime} onChange={setEndTime} />
        </div>

        <div>
          <label className="block text-xs font-semibold text-gray-500 mb-1">备注</label>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="可选备注…"
            className="input text-sm"
          />
        </div>

        <div>
          <label className="block text-xs font-semibold text-gray-500 mb-1">关联待办（可选）</label>
          <select value={todoId} onChange={(event) => setTodoId(event.target.value)} className="input text-sm">
            <option value="">不关联待办</option>
            {todos.map((todo) => <option key={todo.id} value={todo.id}>{todo.title}</option>)}
          </select>
        </div>

        {error && <div className="text-xs text-red-500">{error}</div>}

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
            取消
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="px-5 py-2 rounded-xl text-sm bg-brand text-white hover:bg-brand-600 font-medium transition-colors disabled:opacity-50"
          >
            {saving ? '创建中…' : endTime ? '📥 补录' : '▶️ 开始计时'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ===== 月视图点击日期详情弹窗 =====

function DayDetailPopup({ date, entries, activities, dayMemos, externalEvents, onClose, onEntryClick }: {
  date: Date
  entries: TimeEntry[]
  activities: Todo[]
  dayMemos: Memo[]
  externalEvents: CalendarEvent[]
  onClose: () => void
  onEntryClick: (e: TimeEntry) => void
}) {
  const dayStart = startOfDay(date).getTime()
  const dayEnd = endOfDay(date).getTime()

  const dayEntries = entries.filter((e) => {
    const es = new Date(e.startTime).getTime()
    const ee = e.endTime ? new Date(e.endTime).getTime() : Date.now()
    return es < dayEnd && ee > dayStart
  }).sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())
  const dayActivities = activities.filter((todo) => activityIsOnDay(todo, date))

  const dayExternal = externalEvents.filter((ev) => externalEventOverlapsDay(ev, dayStart, dayEnd))
  const seenExt = new Set<string>()
  const uniqueExternal = dayExternal.filter((e) => { if (seenExt.has(e.summary)) return false; seenExt.add(e.summary); return true })

  const lunarText = getLunarText(date)
  const totalMs = dayEntries.reduce((sum, e) => {
    const start = Math.max(new Date(e.startTime).getTime(), dayStart)
    const end = Math.min(e.endTime ? new Date(e.endTime).getTime() : Date.now(), dayEnd)
    return sum + Math.max(0, end - start)
  }, 0)

  const weekDay = WEEKDAYS_FULL[date.getDay() === 0 ? 6 : date.getDay() - 1]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-sm mx-4 shadow-xl max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 pt-5 pb-3 border-b border-gray-100 dark:border-gray-800">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold">{date.getMonth() + 1}月{date.getDate()}日</span>
                <span className="text-sm text-gray-400">{weekDay}</span>
              </div>
              <div className="text-xs text-gray-400 mt-0.5">农历{lunarText}</div>
            </div>
            <button onClick={onClose} className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400 transition-colors">✕</button>
          </div>
          {totalMs > 0 && (
            <div className="text-xs text-gray-400 mt-2">
              当日合计 <span className="font-mono font-medium text-brand">{formatDuration(totalMs)}</span> · {dayEntries.length} 条记录
            </div>
          )}
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-2">
          {dayActivities.length > 0 && (
            <div className="space-y-1 mb-3">
              <div className="text-[10px] text-gray-400">◆ 活动 ({dayActivities.length})</div>
              {dayActivities.map((todo) => (
                <div key={todo.id} className={`text-xs truncate ${todo.status === 'done' ? 'line-through text-gray-400' : 'text-gray-600 dark:text-gray-300'}`} title={todo.lateReason ?? undefined}>
                  {todo.status === 'done' ? '已完成 · ' : '待完成 · '}{todo.title}
                </div>
              ))}
            </div>
          )}
          {uniqueExternal.length > 0 && (
            <div className="space-y-1 mb-3">
              {uniqueExternal.map((ev) => {
                const color = ev.subscription?.color ?? '#2ecc71'
                return (
                  <div key={ev.id} className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
                    <span className="text-xs font-medium" style={{ color }}>{formatExternalEventLabel(ev)}</span>
                  </div>
                )
              })}
            </div>
          )}
          {dayMemos.length > 0 && (
            <div className="space-y-1 mb-3">
              <div className="text-[10px] text-gray-400">📝 当日记事 ({dayMemos.length})</div>
              {dayMemos.slice(0, 5).map((memo) => (
                <div key={memo.id} className="text-xs text-gray-600 dark:text-gray-300 truncate">
                  {new Date(memo.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} · {memo.content}
                </div>
              ))}
            </div>
          )}
          {dayEntries.length === 0 && dayActivities.length === 0 && uniqueExternal.length === 0 && dayMemos.length === 0 ? (
            <div className="text-center py-6 text-gray-400 text-sm">当日暂无记录</div>
          ) : dayEntries.length === 0 ? (
            <div className="text-center py-4 text-gray-400 text-xs">暂无计时记录</div>
          ) : (
            <div className="space-y-1">
              {dayEntries.map((e) => {
                const start = new Date(e.startTime)
                const end = e.endTime ? new Date(e.endTime) : null
                const color = e.tag?.color ?? '#6d5efc'
                const dur = end ? end.getTime() - start.getTime() : Date.now() - start.getTime()
                return (
                  <button
                    key={e.id}
                    onClick={() => onEntryClick(e)}
                    className="w-full flex items-center gap-3 p-2.5 rounded-xl hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors text-left group"
                  >
                    <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold" style={{ color }}>{e.tag?.name}</span>
                        {e.tag?.category && <span className="text-[9px] text-gray-400">{e.tag.category.name}</span>}
                      </div>
                      <div className="text-[10px] text-gray-400">
                        {start.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                        {end && ` - ${end.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`}
                        {e.note && ` · ${e.note}`}
                      </div>
                    </div>
                    <span className="text-[10px] font-mono text-gray-400">{formatDuration(dur)}</span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t border-gray-100 dark:border-gray-800">
          <button onClick={onClose} className="w-full py-2 rounded-xl text-sm font-medium bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors">
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
