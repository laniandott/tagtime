import { useEffect, useState, useMemo } from 'react'
import { useStore, formatClock, formatDuration } from '../store'
import { api, resolveUploadUrl } from '../api'
import type { TimeEntry, Tag, Memo } from '../types'

// 辅助函数：格式化时间为 YYYY/MM/DD HH:mm:ss
const formatDateTimeWithSeconds = (isoStr: string) => {
  const d = new Date(isoStr)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${yyyy}/${mm}/${dd} ${hh}:${min}:${ss}`
}

// 辅助函数：格式化时间为 HH:mm:ss
const formatTimeWithSeconds = (isoStr: string) => {
  const d = new Date(isoStr)
  const hh = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${min}:${ss}`
}

// 转换 ISO 时间字符串为 datetime-local (精确到秒 YYYY-MM-DDTHH:mm:ss)
const toLocalInputWithSeconds = (d: Date | string) => {
  const date = typeof d === 'string' ? new Date(d) : d
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19)
}

export default function TimerPage() {
  const { tags, categories, running, clockOffset, start, stop, stopAll, quickCount } = useStore()
  const [now, setNow] = useState(Date.now())
  const [recent, setRecent] = useState<TimeEntry[]>([])
  const [stoppingId, setStoppingId] = useState<string | null>(null)
  const [stoppingAll, setStoppingAll] = useState(false)
  const [showManual, setShowManual] = useState(false)
  const [editingEntry, setEditingEntry] = useState<TimeEntry | null>(null)
  const [memoTargetEntry, setMemoTargetEntry] = useState<TimeEntry | null>(null)
  const [pointTargetEntry, setPointTargetEntry] = useState<TimeEntry | null>(null)
  const [filterCat, setFilterCat] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  // 最近记录日期范围：默认显示当天
  const [dateRange, setDateRange] = useState<'today' | 'yesterday' | '7days' | '30days' | 'custom'>('today')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')

  // 每秒刷新计时显示（有进行中的计时时）
  useEffect(() => {
    if (running.length === 0) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [running.length])

  // 加载最近记录（按日期范围筛选）
  const loadRecent = async () => {
    let from: string | undefined
    let to: string | undefined
    const now = new Date()

    if (dateRange === 'today') {
      from = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
      to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59).toISOString()
    } else if (dateRange === 'yesterday') {
      const y = new Date(now)
      y.setDate(y.getDate() - 1)
      from = new Date(y.getFullYear(), y.getMonth(), y.getDate()).toISOString()
      to = new Date(y.getFullYear(), y.getMonth(), y.getDate(), 23, 59, 59).toISOString()
    } else if (dateRange === '7days') {
      const f = new Date(now)
      f.setDate(f.getDate() - 6)
      from = new Date(f.getFullYear(), f.getMonth(), f.getDate()).toISOString()
      to = now.toISOString()
    } else if (dateRange === '30days') {
      const f = new Date(now)
      f.setDate(f.getDate() - 29)
      from = new Date(f.getFullYear(), f.getMonth(), f.getDate()).toISOString()
      to = now.toISOString()
    } else if (dateRange === 'custom') {
      if (customFrom) from = new Date(customFrom + 'T00:00:00').toISOString()
      if (customTo) to = new Date(customTo + 'T23:59:59').toISOString()
    }

    const list = await api.timer.list({ from, to }).catch(() => [])
    setRecent(list)
  }

  useEffect(() => {
    loadRecent()
  }, [running.length, dateRange, customFrom, customTo])

  // 计算某条计时的已用时长（用 clockOffset 修正容器时钟偏差）
  const elapsedOf = (entry: TimeEntry) =>
    (now - clockOffset) - new Date(entry.startTime).getTime()

  const handleStart = async (tagId: string) => {
    const tag = tags.find((t) => t.id === tagId)
    try {
      if (tag?.trackType === 'count') {
        await quickCount(tagId)
        await loadRecent()
      } else {
        await start(tagId)
      }
    } catch (e) {
      alert((e as Error).message)
    }
  }

  const handleStop = async (id: string, note?: string) => {
    setStoppingId(id)
    try {
      await stop(id, note)
      await loadRecent()
    } catch (e) {
      alert((e as Error).message)
    } finally {
      setStoppingId(null)
    }
  }

  const handleStopAll = async () => {
    setStoppingAll(true)
    try {
      await stopAll()
      await loadRecent()
    } catch (e) {
      alert((e as Error).message)
    } finally {
      setStoppingAll(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (confirm('确定要删除这条时间记录吗？')) {
      await api.timer.remove(id)
      await loadRecent()
    }
  }

  // 按分类分组标签
  const tagsByCategory = categories.map((cat) => ({
    category: cat,
    tags: tags.filter((t) => t.categoryId === cat.id),
  }))
  const uncategorized = tags.filter((t) => !t.categoryId)

  // 按结束时间倒序排序（进行中的在最上方，即 endTime 为 null 当作无穷大，已结束的按 endTime 倒序）
  const sortedRecent = [...recent]
    .filter((e) => {
      if (filterCat && !(filterCat === 'none' ? !e.tag?.categoryId : e.tag?.categoryId === filterCat)) return false
      if (searchQuery) {
        const q = searchQuery.toLowerCase()
        const tagName = e.tag?.name?.toLowerCase() ?? ''
        const note = e.note?.toLowerCase() ?? ''
        const memoMatch = e.memos?.some((m) => m.content.toLowerCase().includes(q)) ?? false
        if (!tagName.includes(q) && !note.includes(q) && !memoMatch) return false
      }
      return true
    })
    .sort((a, b) => {
      const timeA = a.endTime ? new Date(a.endTime).getTime() : Number.MAX_SAFE_INTEGER
      const timeB = b.endTime ? new Date(b.endTime).getTime() : Number.MAX_SAFE_INTEGER
      if (timeA !== timeB) return timeB - timeA
      return new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
    })

  return (
    <div className="space-y-6">
      {/* 进行中的计时卡片 */}
      {running.length > 0 ? (
        <div className="space-y-3">
          {running.length > 1 && (
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">{running.length} 个计时进行中</span>
              <button
                onClick={handleStopAll}
                disabled={stoppingAll}
                className="text-sm text-red-500 hover:underline disabled:opacity-50"
              >
                {stoppingAll ? '停止中…' : '全部停止'}
              </button>
            </div>
          )}
          {running.map((entry) => (
            <RunningTimer
              key={entry.id}
              entry={entry}
              elapsed={elapsedOf(entry)}
              stopping={stoppingId === entry.id}
              onStop={(note) => handleStop(entry.id, note)}
              onAddMemo={() => setMemoTargetEntry(entry)}
              onAddPointRecord={() => setPointTargetEntry(entry)}
            />
          ))}
        </div>
      ) : (
        <div className="rounded-2xl border-2 border-dashed border-gray-300 dark:border-gray-700 p-8 text-center text-gray-400">
          <div className="text-5xl mb-3">⏱</div>
          <div className="text-lg font-medium mb-1">未在计时</div>
          <div className="text-sm">选择下方标签即可开始</div>
        </div>
      )}

      {/* 标签选择器 + 补录入口 */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            快速开始
          </h2>
          <button
            onClick={() => setShowManual(true)}
            className="text-sm text-brand hover:underline"
          >
            + 补录
          </button>
        </div>
        {tags.length === 0 ? (
          <div className="text-center py-8 text-gray-400">
            还没有标签，去 <a href="/tags" className="text-brand underline">标签管理</a> 创建一些吧
          </div>
        ) : (
          <div className="space-y-4">
            {tagsByCategory.map(({ category, tags: ts }) =>
              ts.length === 0 ? null : (
                <div key={category.id}>
                  <div className="flex items-center gap-2 mb-2">
                    <span
                      className="w-3 h-3 rounded-full"
                      style={{ background: category.color }}
                    />
                    <span className="text-sm font-medium text-gray-600 dark:text-gray-300">
                      {category.name}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {ts.map((tag) => (
                      <button
                        key={tag.id}
                        onClick={() => handleStart(tag.id)}
                        className={`px-4 py-2 rounded-xl border font-medium text-sm transition-all hover:scale-105 ${tag.trackType === 'count' ? 'border-dashed' : ''}`}
                        style={{ borderColor: tag.color, color: tag.color }}
                      >
                        {tag.icon ? `${tag.icon} ` : ''}{tag.name}
                        {tag.trackType === 'count' && <span className="ml-1 text-xs opacity-60">✓</span>}
                      </button>
                    ))}
                  </div>
                </div>
              )
            )}
            {uncategorized.length > 0 && (
              <div>
                <div className="text-sm font-medium text-gray-400 mb-2">未分类</div>
                <div className="flex flex-wrap gap-2">
                  {uncategorized.map((tag) => (
                    <button
                      key={tag.id}
                      onClick={() => handleStart(tag.id)}
                      className={`px-4 py-2 rounded-xl border font-medium text-sm transition-all hover:scale-105 ${tag.trackType === 'count' ? 'border-dashed' : ''}`}
                      style={{ borderColor: tag.color, color: tag.color }}
                    >
                      {tag.icon ? `${tag.icon} ` : ''}{tag.name}
                      {tag.trackType === 'count' && <span className="ml-1 text-xs opacity-60">✓</span>}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 最近记录时间线 */}
      <div>
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide flex items-center gap-1.5">
              <span>📅 活动时间线</span>
              <span className="text-xs font-normal text-gray-400">（按结束时间倒序）</span>
            </h2>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {/* 搜索框 */}
            <div className="relative">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索标题/备注/打点…"
                className="text-xs border border-gray-200 dark:border-gray-800 rounded-lg pl-7 pr-2 py-1 bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300 w-36 focus:w-48 transition-all focus:outline-none focus:border-brand"
              />
              <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-xs">🔍</span>
            </div>
            {/* 日期范围快捷选项 */}
            <div className="flex gap-1">
              {([
                { key: 'today', label: '今天' },
                { key: 'yesterday', label: '昨天' },
                { key: '7days', label: '近7天' },
                { key: '30days', label: '近30天' },
                { key: 'custom', label: '自定义' },
              ] as const).map((r) => (
                <button
                  key={r.key}
                  onClick={() => setDateRange(r.key)}
                  className={`px-2 py-1 rounded-full text-xs ${dateRange === r.key ? 'bg-brand-100 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300' : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'}`}
                >
                  {r.label}
                </button>
              ))}
            </div>
            {/* 自定义日期区间 */}
            {dateRange === 'custom' && (
              <div className="flex items-center gap-1">
                <input
                  type="date"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  max={customTo || undefined}
                  className="text-xs border border-gray-200 dark:border-gray-800 rounded-lg px-2 py-1 bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300"
                />
                <span className="text-gray-400 text-xs">至</span>
                <input
                  type="date"
                  value={customTo}
                  onChange={(e) => setCustomTo(e.target.value)}
                  min={customFrom || undefined}
                  className="text-xs border border-gray-200 dark:border-gray-800 rounded-lg px-2 py-1 bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300"
                />
              </div>
            )}
            {/* 分类筛选 */}
            <select
              value={filterCat}
              onChange={(e) => setFilterCat(e.target.value)}
              className="text-xs border border-gray-200 dark:border-gray-800 rounded-lg px-2 py-1 bg-white dark:bg-gray-900 text-gray-500"
            >
              <option value="">全部分类</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
              <option value="none">未分类</option>
            </select>
          </div>
        </div>

        {/* 最近活动时间线列表 */}
        {sortedRecent.length > 0 ? (
          <div className="pt-2">
            {sortedRecent.map((e) => (
              <TimelineEntryItem
                key={e.id}
                entry={e}
                onAddMemo={(entry) => setMemoTargetEntry(entry)}
                onAddPoint={(entry) => setPointTargetEntry(entry)}
                onEdit={(entry) => setEditingEntry(entry)}
                onDelete={(id) => handleDelete(id)}
                onReload={loadRecent}
              />
            ))}
          </div>
        ) : (
          tags.length > 0 && (
            <div className="text-center py-8 text-gray-400 text-sm bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800">
              {dateRange === 'custom' && !customFrom && !customTo
                ? '请选择日期区间'
                : '该时间段暂无记录'}
            </div>
          )
        )}
      </div>

      {/* 点记录弹窗 */}
      {pointTargetEntry && (
        <PointRecordModal
          entry={pointTargetEntry}
          onClose={() => setPointTargetEntry(null)}
          onSaved={async () => {
            setPointTargetEntry(null)
            await loadRecent()
          }}
        />
      )}

      {/* 记事/日记弹窗 */}
      {memoTargetEntry && (
        <MemoCreateModal
          entry={memoTargetEntry}
          onClose={() => setMemoTargetEntry(null)}
          onSaved={async () => {
            setMemoTargetEntry(null)
            await loadRecent()
          }}
        />
      )}

      {/* 补录弹窗 */}
      {showManual && (
        <ManualEntryModal
          tags={tags}
          categories={categories}
          onClose={() => setShowManual(false)}
          onSaved={async () => {
            setShowManual(false)
            await loadRecent()
          }}
        />
      )}

      {/* 编辑记录弹窗 */}
      {editingEntry && (
        <EntryEditModal
          entry={editingEntry}
          tags={tags}
          onClose={() => setEditingEntry(null)}
          onSaved={async () => {
            setEditingEntry(null)
            await loadRecent()
          }}
        />
      )}
    </div>
  )
}

// 进行中计时卡片
function RunningTimer({ entry, elapsed, stopping, onStop, onAddMemo, onAddPointRecord }: {
  entry: TimeEntry
  elapsed: number
  stopping: boolean
  onStop: (note?: string) => void
  onAddMemo: () => void
  onAddPointRecord: () => void
}) {
  const [note, setNote] = useState(entry.note ?? '')
  const [noteSaved, setNoteSaved] = useState(false)

  const saveNote = async () => {
    await api.timer.update(entry.id, { note })
    setNoteSaved(true)
    setTimeout(() => setNoteSaved(false), 1500)
  }

  return (
    <div className="rounded-2xl border-2 border-brand-300 dark:border-brand-700 bg-brand-50 dark:bg-brand-900/20 p-6 text-center relative">
      <div className="text-sm text-gray-500 dark:text-gray-400 mb-2 flex items-center justify-center gap-2">
        <span>正在计时</span>
        {entry.tag?.category && (
          <span
            className="text-xs px-2.5 py-0.5 rounded-full font-medium border"
            style={{
              backgroundColor: `${entry.tag.category.color}18`,
              color: entry.tag.category.color,
              borderColor: `${entry.tag.category.color}40`,
            }}
          >
            {entry.tag.category.icon ? `${entry.tag.category.icon} ` : ''}
            {entry.tag.category.name}
          </span>
        )}
      </div>
      <div className="text-3xl font-bold mb-2" style={{ color: entry.tag?.color }}>
        {entry.tag?.name}
      </div>
      <div className="text-5xl font-mono font-bold tabular-nums text-brand my-4">
        {formatClock(elapsed)}
      </div>
      <div className="text-xs text-gray-400 mb-4">
        开始于 {formatTimeWithSeconds(entry.startTime)}
      </div>
      {/* 备注编辑 */}
      <div className="flex gap-2 mb-4 max-w-sm mx-auto">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="添加简单备注…"
          className="input !py-1.5 text-sm"
        />
        <button
          onClick={saveNote}
          className="px-3 py-1.5 rounded-lg text-sm bg-brand-200 dark:bg-brand-800 text-brand-700 dark:text-brand-200 hover:bg-brand-300 whitespace-nowrap"
        >
          {noteSaved ? '✓ 已存' : '存备注'}
        </button>
      </div>
      {/* 按钮行：点记录 / 记日记 / 停止 */}
      <div className="flex justify-center items-center gap-3">
        <button
          type="button"
          onClick={onAddPointRecord}
          className="px-4 py-2.5 rounded-xl border border-blue-300 dark:border-blue-700 text-blue-600 dark:text-blue-400 font-medium hover:bg-blue-50 dark:hover:bg-blue-900/40 text-sm transition-colors flex items-center gap-1.5"
        >
          📍 点记录
        </button>

        <button
          type="button"
          onClick={onAddMemo}
          className="px-4 py-2.5 rounded-xl border border-brand-300 dark:border-brand-700 text-brand font-medium hover:bg-brand-100 dark:hover:bg-brand-900/40 text-sm transition-colors flex items-center gap-1.5"
        >
          📝 记日记
        </button>

        <button
          onClick={() => onStop(note)}
          disabled={stopping}
          className="px-8 py-2.5 rounded-xl bg-red-500 hover:bg-red-600 text-white font-semibold disabled:opacity-50 transition-colors flex items-center gap-1.5"
        >
          {stopping ? '停止中…' : '⏹ 停止'}
        </button>
      </div>
    </div>
  )
}

// 活动时间线单条组件（节点线 + 结束时间倒序 + 内联下拉点记录/日记）
function TimelineEntryItem({
  entry,
  onAddMemo,
  onAddPoint,
  onEdit,
  onDelete,
  onReload,
}: {
  entry: TimeEntry
  onAddMemo: (e: TimeEntry) => void
  onAddPoint: (e: TimeEntry) => void
  onEdit: (e: TimeEntry) => void
  onDelete: (id: string) => void
  onReload: () => void
}) {
  const pointMemos = useMemo(() => (entry.memos || []).filter((m) => m.type === 'point'), [entry.memos])
  const diaryMemos = useMemo(() => (entry.memos || []).filter((m) => m.type !== 'point'), [entry.memos])

  const [showPoints, setShowPoints] = useState(false)
  const [showDiaries, setShowDiaries] = useState(false)
  const [editingMemo, setEditingMemo] = useState<Memo | null>(null)
  const [previewImage, setPreviewImage] = useState<string | null>(null)
  const [previewVideo, setPreviewVideo] = useState<string | null>(null)

  const isRunning = !entry.endTime
  const displayEndTime = entry.endTime ? formatTimeWithSeconds(entry.endTime) : '进行中'

  return (
    <div className="relative pl-8 pb-6 group last:pb-0">
      {/* 时间线连接轴 (Vertical Line Stem) */}
      <div className="absolute left-3 top-3 bottom-0 w-0.5 bg-gray-200 dark:bg-gray-800 group-last:hidden" />

      {/* 时间线节点图标/圆圈 (Node Dot / Icon) */}
      <div
        className={`absolute -left-[1px] top-1.5 w-6 h-6 rounded-full border-2 border-white dark:border-gray-900 shadow-sm z-10 flex items-center justify-center text-xs transition-transform ${isRunning ? 'animate-pulse ring-2 ring-brand' : ''}`}
        style={{ background: entry.tag?.color ?? '#6d5efc' }}
      >
        {entry.tag?.icon ? (
          <span className="text-[11px] leading-none">{entry.tag.icon}</span>
        ) : (
          <span className="w-1.5 h-1.5 rounded-full bg-white" />
        )}
      </div>

      {/* 时间线主体卡片 */}
      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-200/80 dark:border-gray-800 p-4 shadow-sm hover:shadow-md transition-all">
        {/* 卡片头部信息 */}
        <div className="flex items-start justify-between gap-3 min-w-0">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-base font-semibold text-gray-800 dark:text-gray-100 truncate">
                {entry.tag?.icon ? `${entry.tag.icon} ` : ''}{entry.tag?.name}
              </span>
              {entry.tag?.category && (
                <span
                  className="text-xs px-2.5 py-0.5 rounded-full font-medium border"
                  style={{
                    backgroundColor: `${entry.tag.category.color}18`,
                    color: entry.tag.category.color,
                    borderColor: `${entry.tag.category.color}40`,
                  }}
                >
                  {entry.tag.category.icon ? `${entry.tag.category.icon} ` : ''}
                  {entry.tag.category.name}
                </span>
              )}
              {isRunning && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300 font-medium animate-pulse">
                  ● 进行中
                </span>
              )}

              {/* 小三角折叠/展开：点记录 */}
              {pointMemos.length > 0 && (
                <button
                  onClick={() => setShowPoints(!showPoints)}
                  className="text-xs px-2.5 py-0.5 rounded-full bg-blue-50 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 font-medium hover:bg-blue-100 transition-colors flex items-center gap-1"
                >
                  <span>{showPoints ? '▼' : '►'} 📍 点记录 ({pointMemos.length}条)</span>
                </button>
              )}

              {/* 小三角折叠/展开：日记/随感 */}
              {diaryMemos.length > 0 && (
                <button
                  onClick={() => setShowDiaries(!showDiaries)}
                  className="text-xs px-2.5 py-0.5 rounded-full bg-green-50 dark:bg-green-900/40 text-green-700 dark:text-green-300 font-medium hover:bg-green-100 transition-colors flex items-center gap-1"
                >
                  <span>{showDiaries ? '▼' : '►'} 📝 日记 ({diaryMemos.length}篇)</span>
                </button>
              )}
            </div>

            {/* 时间线时间范围 (突出结束时间排序) */}
            <div className="text-xs text-gray-400 font-mono mt-1 flex items-center gap-2 flex-wrap">
              <span className="text-gray-600 dark:text-gray-300 font-medium bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded">
                结束: {displayEndTime}
              </span>
              <span>•</span>
              <span>
                {formatDateTimeWithSeconds(entry.startTime)}
                {entry.endTime ? ` → ${formatTimeWithSeconds(entry.endTime)}` : ''}
              </span>
            </div>

            {/* 备注 */}
            {entry.note && (
              <div className="text-xs text-gray-600 dark:text-gray-300 bg-gray-50 dark:bg-gray-800/60 rounded-lg px-2.5 py-1.5 mt-2 border border-gray-100 dark:border-gray-800 inline-block">
                💬 {entry.note}
              </div>
            )}
          </div>

          {/* 右侧时长与操作按钮：点记录 / 记日记 / 编辑 / 删除 */}
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className="text-sm font-mono font-semibold text-brand bg-brand-50 dark:bg-brand-900/30 px-2.5 py-1 rounded-lg">
              {entry.endTime
                ? formatDuration(new Date(entry.endTime).getTime() - new Date(entry.startTime).getTime())
                : '进行中'}
            </span>
            <button
              onClick={() => onAddPoint(entry)}
              className="text-xs px-2 py-1.5 rounded-lg border border-blue-200 dark:border-blue-800 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-colors flex items-center gap-1"
              title="添加点记录"
            >
              📍 打点
            </button>
            <button
              onClick={() => onAddMemo(entry)}
              className="text-xs px-2 py-1.5 rounded-lg border border-brand-200 dark:border-brand-800 text-brand hover:bg-brand-50 dark:hover:bg-brand-900/30 transition-colors flex items-center gap-1"
              title="写关联日记"
            >
              📝 记日记
            </button>
            <button
              onClick={() => onEdit(entry)}
              className="text-gray-400 hover:text-brand p-1 text-sm transition-colors"
              title="编辑"
            >
              ✎
            </button>
            <button
              onClick={() => onDelete(entry.id)}
              className="text-gray-400 hover:text-red-500 p-1 text-sm transition-colors"
              title="删除"
            >
              ✕
            </button>
          </div>
        </div>

        {/* 内联下拉：点记录列表 */}
        {showPoints && pointMemos.length > 0 && (
          <div className="mt-3 rounded-xl border border-blue-100 dark:border-blue-900/50 bg-blue-50/40 dark:bg-blue-900/10 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-blue-600 dark:text-blue-400 flex items-center gap-1">
                <span className="text-[10px]">▼</span> 📍 点记录 ({pointMemos.length}条)
              </span>
              <button
                onClick={() => onAddPoint(entry)}
                className="text-xs px-2 py-1 rounded-lg bg-brand text-white font-medium hover:bg-brand-600 transition-colors"
              >
                + 添加打点
              </button>
            </div>
            <div className="space-y-2">
              {pointMemos.map((m: Memo) => (
                <MemoInlineItem
                  key={m.id}
                  memo={m}
                  onEdit={() => setEditingMemo(m)}
                  onDelete={async () => {
                    if (confirm('确定要删除这条点记录吗？')) {
                      await api.memos.remove(m.id)
                      await onReload()
                    }
                  }}
                  onPreviewImage={(url) => setPreviewImage(url)}
                  onPreviewVideo={(url) => setPreviewVideo(url)}
                />
              ))}
            </div>
          </div>
        )}

        {/* 内联下拉：日记列表 */}
        {showDiaries && diaryMemos.length > 0 && (
          <div className="mt-3 rounded-xl border border-green-100 dark:border-green-900/50 bg-green-50/40 dark:bg-green-900/10 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-green-600 dark:text-green-400 flex items-center gap-1">
                <span className="text-[10px]">▼</span> 📝 关联日记 ({diaryMemos.length}篇)
              </span>
              <button
                onClick={() => onAddMemo(entry)}
                className="text-xs px-2 py-1 rounded-lg bg-brand text-white font-medium hover:bg-brand-600 transition-colors"
              >
                + 写日记
              </button>
            </div>
            <div className="space-y-2">
              {diaryMemos.map((m: Memo) => (
                <MemoInlineItem
                  key={m.id}
                  memo={m}
                  onEdit={() => setEditingMemo(m)}
                  onDelete={async () => {
                    if (confirm('确定要删除这篇日记吗？')) {
                      await api.memos.remove(m.id)
                      await onReload()
                    }
                  }}
                  onPreviewImage={(url) => setPreviewImage(url)}
                  onPreviewVideo={(url) => setPreviewVideo(url)}
                />
              ))}
            </div>
          </div>
        )}

        {/* 大图预览弹窗 */}
        {previewImage && (
          <div
            className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
            onClick={() => setPreviewImage(null)}
          >
            <img src={previewImage} alt="大图预览" className="max-w-full max-h-full rounded-lg object-contain" />
          </div>
        )}

        {/* 视频全屏播放弹窗 */}
        {previewVideo && (
          <div
            className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4"
            onClick={() => setPreviewVideo(null)}
          >
            <div className="relative max-w-3xl w-full" onClick={(e) => e.stopPropagation()}>
              <button
                onClick={() => setPreviewVideo(null)}
                className="absolute -top-10 right-0 text-white text-xl font-bold p-2"
              >
                ✕ 关闭
              </button>
              <video src={previewVideo} controls autoPlay className="w-full max-h-[80vh] rounded-lg" />
            </div>
          </div>
        )}

        {/* 编辑弹窗 */}
        {editingMemo && (
          <MemoEditModal
            memo={editingMemo}
            onClose={() => setEditingMemo(null)}
            onSaved={async () => {
              setEditingMemo(null)
              await onReload()
            }}
          />
        )}
      </div>
    </div>
  )
}

// 内联展示单条 Memo（点记录 / 日记通用）
function MemoInlineItem({
  memo,
  onEdit,
  onDelete,
  onPreviewImage,
  onPreviewVideo,
}: {
  memo: Memo
  onEdit: () => void
  onDelete: () => void
  onPreviewImage: (url: string) => void
  onPreviewVideo: (url: string) => void
}) {
  return (
    <div className="p-3 rounded-lg bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs text-brand font-semibold">
          {formatTimeWithSeconds(memo.createdAt)}
        </span>
        <div className="flex items-center gap-2">
          <button onClick={onEdit} className="text-xs text-gray-400 hover:text-brand">✎ 编辑</button>
          <button onClick={onDelete} className="text-xs text-gray-400 hover:text-red-500">✕ 删除</button>
        </div>
      </div>
      <div className="text-xs text-gray-700 dark:text-gray-200 whitespace-pre-wrap break-words">{memo.content}</div>
      {memo.attachments && memo.attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {memo.attachments.map((att) =>
            att.mimeType.startsWith('image/') ? (
              <button
                key={att.id || att.path}
                type="button"
                onClick={() => onPreviewImage(resolveUploadUrl(att.path))}
                className="w-12 h-12 rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-gray-800 flex-shrink-0"
              >
                <img src={resolveUploadUrl(att.path)} alt={att.filename} className="w-full h-full object-cover" />
              </button>
            ) : att.mimeType.startsWith('video/') ? (
              <button
                key={att.id || att.path}
                type="button"
                onClick={() => onPreviewVideo(resolveUploadUrl(att.path))}
                className="w-12 h-12 rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700 bg-black flex items-center justify-center flex-shrink-0 relative"
              >
                <span className="text-lg">🎬</span>
                <span className="absolute bottom-0 inset-x-0 bg-black/60 text-[9px] text-white text-center">播放</span>
              </button>
            ) : null
          )}
        </div>
      )}
    </div>
  )
}

// 点记录弹窗
export function PointRecordModal({
  entry,
  onClose,
  onSaved,
}: {
  entry: TimeEntry
  onClose: () => void
  onSaved: () => void
}) {
  const [pointTime, setPointTime] = useState(toLocalInputWithSeconds(new Date()))
  const [content, setContent] = useState('')
  const [error, setError] = useState('')

  const save = async () => {
    if (!content.trim()) {
      setError('请输入点记录内容')
      return
    }
    setError('')
    try {
      await api.memos.create({
        content: content.trim(),
        timeEntryId: entry.id,
        tagId: entry.tagId,
        createdAt: new Date(pointTime).toISOString(),
      })
      onSaved()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <ModalShell title={`添加点记录 · ${entry.tag?.name ?? ''}`} onClose={onClose}>
      <div className="space-y-4">
        <div>
          <label className="block text-sm text-gray-500 mb-1">打点时刻 (精准到秒)</label>
          <input
            type="datetime-local"
            step="1"
            value={pointTime}
            onChange={(e) => setPointTime(e.target.value)}
            className="input font-mono text-sm"
          />
        </div>

        <div>
          <label className="block text-sm text-gray-500 mb-1">这个时间点做了什么事？</label>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={3}
            placeholder="如：拉了个屎、看了下邮件、洗了个手..."
            className="input"
            autoFocus
          />
        </div>

        {error && <div className="text-sm text-red-500">{error}</div>}
      </div>
      <FormActions onCancel={onClose} onSave={save} saveLabel="保存点记录" />
    </ModalShell>
  )
}

// 补录弹窗
function ManualEntryModal({ tags, categories, onClose, onSaved }: {
  tags: Tag[]
  categories: { id: string; name: string; color: string }[]
  onClose: () => void
  onSaved: () => void
}) {
  const now = new Date()
  const nowLocal = toLocalInputWithSeconds(now)
  const twoHoursAgo = new Date(now.getTime() - 2 * 3600000)
  const twoHoursAgoLocal = toLocalInputWithSeconds(twoHoursAgo)

  const [tagId, setTagId] = useState(tags[0]?.id ?? '')
  const [startTime, setStartTime] = useState(twoHoursAgoLocal)
  const [endTime, setEndTime] = useState(nowLocal)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')

  const save = async () => {
    setError('')
    if (!tagId) {
      setError('请选择标签')
      return
    }
    try {
      await api.timer.manual({
        tagId,
        startTime: new Date(startTime).toISOString(),
        endTime: new Date(endTime).toISOString(),
        note: note || undefined,
      })
      onSaved()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <ModalShell title="补录时间记录" onClose={onClose}>
      <div className="space-y-4">
        <div>
          <label className="block text-sm text-gray-500 mb-1">标签</label>
          <select value={tagId} onChange={(e) => setTagId(e.target.value)} className="input">
            <option value="">请选择…</option>
            {categories.map((c) => (
              <optgroup key={c.id} label={c.name}>
                {tags.filter((t) => t.categoryId === c.id).map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </optgroup>
            ))}
            {tags.filter((t) => !t.categoryId).length > 0 && (
              <optgroup label="未分类">
                {tags.filter((t) => !t.categoryId).map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </optgroup>
            )}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm text-gray-500 mb-1">开始时间 (带秒)</label>
            <input
              type="datetime-local"
              step="1"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              className="input font-mono text-sm"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-500 mb-1">结束时间 (带秒)</label>
            <input
              type="datetime-local"
              step="1"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              className="input font-mono text-sm"
            />
          </div>
        </div>
        <div>
          <label className="block text-sm text-gray-500 mb-1">备注（可选）</label>
          <input value={note} onChange={(e) => setNote(e.target.value)} className="input" placeholder="如：完成了 XX 任务" />
        </div>
        {error && <div className="text-sm text-red-500">{error}</div>}
      </div>
      <FormActions onCancel={onClose} onSave={save} saveLabel="补录" />
    </ModalShell>
  )
}

// 编辑记录弹窗
function EntryEditModal({ entry, tags, onClose, onSaved }: {
  entry: TimeEntry
  tags: Tag[]
  onClose: () => void
  onSaved: () => void
}) {
  const [tagId, setTagId] = useState(entry.tagId)
  const [startTime, setStartTime] = useState(toLocalInputWithSeconds(entry.startTime))
  const [endTime, setEndTime] = useState(entry.endTime ? toLocalInputWithSeconds(entry.endTime) : '')
  const [note, setNote] = useState(entry.note ?? '')
  const [error, setError] = useState('')

  const save = async () => {
    setError('')
    if (endTime && new Date(endTime) <= new Date(startTime)) {
      setError('结束时间必须晚于开始时间')
      return
    }
    try {
      await api.timer.update(entry.id, {
        tagId,
        startTime: new Date(startTime).toISOString(),
        endTime: endTime ? new Date(endTime).toISOString() : null,
        note,
      })
      onSaved()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <ModalShell title="编辑时间记录" onClose={onClose}>
      <div className="space-y-4">
        <div>
          <label className="block text-sm text-gray-500 mb-1">标签</label>
          <select value={tagId} onChange={(e) => setTagId(e.target.value)} className="input">
            {tags.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm text-gray-500 mb-1">开始时间 (带秒)</label>
            <input
              type="datetime-local"
              step="1"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              className="input font-mono text-sm"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-500 mb-1">结束时间 (带秒)</label>
            <input
              type="datetime-local"
              step="1"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              placeholder={entry.endTime ? '' : '空表示进行中'}
              className="input font-mono text-sm"
            />
          </div>
        </div>
        <div>
          <label className="block text-sm text-gray-500 mb-1">备注</label>
          <input value={note} onChange={(e) => setNote(e.target.value)} className="input" />
        </div>
        {error && <div className="text-sm text-red-500">{error}</div>}
      </div>
      <FormActions onCancel={onClose} onSave={save} saveLabel="保存" />
    </ModalShell>
  )
}

// 通用弹窗壳
function ModalShell({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 rounded-2xl p-6 w-full max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold mb-4">{title}</h3>
        {children}
      </div>
    </div>
  )
}

function FormActions({ onCancel, onSave, saveLabel }: { onCancel: () => void; onSave: () => void; saveLabel: string }) {
  return (
    <div className="flex justify-end gap-2 mt-6">
      <button onClick={onCancel} className="px-4 py-2 rounded-lg text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800">
        取消
      </button>
      <button onClick={onSave} className="px-4 py-2 rounded-lg text-sm bg-brand text-white hover:bg-brand-600">
        {saveLabel}
      </button>
    </div>
  )
}

// 关联到计时的记事/日记弹窗
export function MemoCreateModal({
  entry,
  onClose,
  onSaved,
}: {
  entry: TimeEntry
  onClose: () => void
  onSaved: () => void
}) {
  const [content, setContent] = useState('')
  const [uploading, setUploading] = useState(false)
  const [attachments, setAttachments] = useState<{ filename: string; path: string; mimeType: string; size: number }[]>([])
  const [error, setError] = useState('')
  const [memoTime, setMemoTime] = useState(toLocalInputWithSeconds(new Date()))

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return

    setUploading(true)
    setError('')
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        const res = await api.memos.upload(file)
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
      setError('请输入记事内容或上传文件')
      return
    }
    setError('')
    try {
      await api.memos.create({
        content: content.trim() || '（无文字附记）',
        timeEntryId: entry.id,
        tagId: entry.tagId,
        createdAt: new Date(memoTime).toISOString(),
        attachments,
      })
      onSaved()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <ModalShell title={`添加日记 / 随手记 · ${entry.tag?.name ?? ''}`} onClose={onClose}>
      <div className="space-y-4">
        <div>
          <label className="block text-sm text-gray-500 mb-1">记事时间 (精准到秒)</label>
          <input
            type="datetime-local"
            step="1"
            value={memoTime}
            onChange={(e) => setMemoTime(e.target.value)}
            className="input font-mono text-sm"
          />
        </div>

        <div>
          <label className="block text-sm text-gray-500 mb-1">感悟 / 记事内容</label>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={4}
            placeholder="写下当前计时时间段内的想法、收获或日志..."
            className="input"
            autoFocus
          />
        </div>

        <div>
          <label className="block text-sm text-gray-500 mb-1">多媒体附件（图片 / 视频）</label>
          <input
            type="file"
            accept="image/*,video/*"
            multiple
            onChange={handleFileUpload}
            disabled={uploading}
            className="block w-full text-xs text-gray-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-brand-50 file:text-brand dark:file:bg-brand-900/40 dark:file:text-brand-300 hover:file:bg-brand-100"
          />
          {uploading && <div className="text-xs text-brand mt-1">文件上传中...</div>}
        </div>

        {attachments.length > 0 && (
          <div className="grid grid-cols-3 gap-2 pt-2">
            {attachments.map((att, idx) => (
              <div key={idx} className="relative group rounded-lg overflow-hidden border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800 h-20 flex items-center justify-center">
                {att.mimeType.startsWith('image/') ? (
                  <img src={resolveUploadUrl(att.path)} alt={att.filename} className="w-full h-full object-cover" />
                ) : (
                  <div className="text-center p-1">
                    <span className="text-lg">🎬</span>
                    <div className="text-[10px] truncate max-w-[80px]">{att.filename}</div>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setAttachments(attachments.filter((_, i) => i !== idx))}
                  className="absolute top-1 right-1 bg-black/60 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        {error && <div className="text-sm text-red-500">{error}</div>}
      </div>
      <FormActions onCancel={onClose} onSave={save} saveLabel="保存记事" />
    </ModalShell>
  )
}

// 编辑记事弹窗
export function MemoEditModal({
  memo,
  onClose,
  onSaved,
}: {
  memo: Memo
  onClose: () => void
  onSaved: () => void
}) {
  const [content, setContent] = useState(memo.content)
  const [memoTime, setMemoTime] = useState(toLocalInputWithSeconds(memo.createdAt))
  const [uploading, setUploading] = useState(false)
  const [attachments, setAttachments] = useState(
    (memo.attachments ?? []).map((a) => ({
      filename: a.filename,
      path: a.path,
      mimeType: a.mimeType,
      size: a.size,
    }))
  )
  const [error, setError] = useState('')

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return
    setUploading(true)
    setError('')
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        const res = await api.memos.upload(file)
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
      setError('请输入记事内容或上传文件')
      return
    }
    setError('')
    try {
      await api.memos.update(memo.id, {
        content: content.trim() || '（无文字附记）',
        createdAt: new Date(memoTime).toISOString(),
        attachments,
      })
      onSaved()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <ModalShell title="编辑记事" onClose={onClose}>
      <div className="space-y-4">
        <div>
          <label className="block text-sm text-gray-500 mb-1">记事时间 (精准到秒)</label>
          <input
            type="datetime-local"
            step="1"
            value={memoTime}
            onChange={(e) => setMemoTime(e.target.value)}
            className="input font-mono text-sm"
          />
        </div>

        <div>
          <label className="block text-sm text-gray-500 mb-1">感悟 / 记事内容</label>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={4}
            className="input"
            autoFocus
          />
        </div>

        <div>
          <label className="block text-sm text-gray-500 mb-1">多媒体附件（图片 / 视频）</label>
          <input
            type="file"
            accept="image/*,video/*"
            multiple
            onChange={handleFileUpload}
            disabled={uploading}
            className="block w-full text-xs text-gray-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-brand-50 file:text-brand dark:file:bg-brand-900/40 dark:file:text-brand-300 hover:file:bg-brand-100"
          />
          {uploading && <div className="text-xs text-brand mt-1">文件上传中...</div>}
        </div>

        {attachments.length > 0 && (
          <div className="grid grid-cols-3 gap-2 pt-2">
            {attachments.map((att, idx) => (
              <div key={idx} className="relative group rounded-lg overflow-hidden border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800 h-20 flex items-center justify-center">
                {att.mimeType.startsWith('image/') ? (
                  <img src={resolveUploadUrl(att.path)} alt={att.filename} className="w-full h-full object-cover" />
                ) : (
                  <div className="text-center p-1">
                    <span className="text-lg">🎬</span>
                    <div className="text-[10px] truncate max-w-[80px]">{att.filename}</div>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setAttachments(attachments.filter((_, i) => i !== idx))}
                  className="absolute top-1 right-1 bg-black/60 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        {error && <div className="text-sm text-red-500">{error}</div>}
      </div>
      <FormActions onCancel={onClose} onSave={save} saveLabel="保存修改" />
    </ModalShell>
  )
}
