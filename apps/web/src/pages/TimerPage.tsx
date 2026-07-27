import { useEffect, useState } from 'react'
import { useStore, formatClock } from '../store'
import { api } from '../api'
import type { TimeEntry, Tag, Memo } from '../types'
import { formatDuration } from '../store'

export default function TimerPage() {
  const { tags, categories, running, clockOffset, start, stop, stopAll, quickCount } = useStore()
  const [now, setNow] = useState(Date.now())
  const [recent, setRecent] = useState<TimeEntry[]>([])
  const [stoppingId, setStoppingId] = useState<string | null>(null)
  const [stoppingAll, setStoppingAll] = useState(false)
  const [showManual, setShowManual] = useState(false)
  const [editingEntry, setEditingEntry] = useState<TimeEntry | null>(null)
  const [memoTargetEntry, setMemoTargetEntry] = useState<TimeEntry | null>(null)
  const [filterCat, setFilterCat] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  // 最近记录日期范围：默认显示当天
  const [dateRange, setDateRange] = useState<'today' | 'yesterday' | '7days' | '30days' | 'custom'>('today')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')

  // 每秒刷新计时显示（有进行中的计时时）
  useEffect(() => {
    if (running.length === 0) return
    setNow(Date.now()) // 立即同步，避免显示旧时间
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
        // 次数型：点击即打卡
        await quickCount(tagId)
        await loadRecent()
      } else {
        // 时长型：开始计时
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

  // 按分类分组标签
  const tagsByCategory = categories.map((cat) => ({
    category: cat,
    tags: tags.filter((t) => t.categoryId === cat.id),
  }))
  const uncategorized = tags.filter((t) => !t.categoryId)

  return (
    <div className="space-y-6">
      {/* 进行中的计时卡片（支持多个同步计时） */}
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

      {/* 最近记录 */}
      <div>
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            最近记录
          </h2>
          <div className="flex items-center gap-2 flex-wrap">
            {/* 搜索框 */}
            <div className="relative">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索标题/备注…"
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
        <div className="space-y-2">
          {recent
            .filter((e) => {
              // 分类筛选
              if (filterCat && !(filterCat === 'none' ? !e.tag?.categoryId : e.tag?.categoryId === filterCat)) return false
              // 搜索筛选：匹配标签名或备注
              if (searchQuery) {
                const q = searchQuery.toLowerCase()
                const tagName = e.tag?.name?.toLowerCase() ?? ''
                const note = e.note?.toLowerCase() ?? ''
                if (!tagName.includes(q) && !note.includes(q)) return false
              }
              return true
            })
            .map((e) => (
            <div
              key={e.id}
              className="flex items-center justify-between rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 px-4 py-2.5"
            >
              <div className="flex items-center gap-3 min-w-0">
                <span
                  className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                  style={{ background: e.tag?.color }}
                />
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{e.tag?.name}</div>
                  <div className="text-xs text-gray-400">
                    {new Date(e.startTime).toLocaleString('zh-CN', { hour12: false })}
                    {e.endTime ? ` → ${new Date(e.endTime).toLocaleTimeString('zh-CN', { hour12: false })}` : ''}
                  </div>
                  {e.note && (
                    <div className="text-xs text-gray-400 truncate mt-0.5">📝 {e.note}</div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-3 flex-shrink-0">
                <span className="text-sm font-mono text-gray-500">
                  {e.endTime ? formatDuration(new Date(e.endTime).getTime() - new Date(e.startTime).getTime()) : '进行中'}
                </span>
                <button
                  onClick={() => setMemoTargetEntry(e)}
                  className="text-gray-300 hover:text-brand text-sm"
                  title="添加记事/日记"
                >
                  📝
                </button>
                <button
                  onClick={() => setEditingEntry(e)}
                  className="text-gray-300 hover:text-brand text-sm"
                  title="编辑"
                >
                  ✎
                </button>
                <button
                  onClick={async () => {
                    await api.timer.remove(e.id)
                    await loadRecent()
                  }}
                  className="text-gray-300 hover:text-red-500 text-sm"
                  title="删除"
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
          {/* 空状态提示（仅在有标签时显示，避免首次使用时空白） */}
          {tags.length > 0 && recent.length === 0 && (
            <div className="text-center py-6 text-gray-400 text-sm">
              {dateRange === 'custom' && !customFrom && !customTo
                ? '请选择日期区间'
                : '该时间段暂无记录'}
            </div>
          )}
        </div>
      </div>

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

// 进行中计时卡片（含备注编辑）
function RunningTimer({ entry, elapsed, stopping, onStop, onAddMemo }: {
  entry: TimeEntry
  elapsed: number
  stopping: boolean
  onStop: (note?: string) => void
  onAddMemo: () => void
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
      <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">
        正在计时 · {entry.tag?.category?.name ?? '未分类'}
      </div>
      <div className="text-3xl font-bold mb-2" style={{ color: entry.tag?.color }}>
        {entry.tag?.name}
      </div>
      <div className="text-5xl font-mono font-bold tabular-nums text-brand my-4">
        {formatClock(elapsed)}
      </div>
      <div className="text-xs text-gray-400 mb-4">
        开始于 {new Date(entry.startTime).toLocaleTimeString('zh-CN')}
      </div>
      {/* 备注编辑 & 记事入口 */}
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
      <div className="flex justify-center items-center gap-3">
        <button
          type="button"
          onClick={onAddMemo}
          className="px-4 py-2.5 rounded-xl border border-brand-300 dark:border-brand-700 text-brand font-medium hover:bg-brand-100 dark:hover:bg-brand-900/40 text-sm transition-colors"
        >
          📝 记事 / 日记
        </button>
        <button
          onClick={() => onStop(note)}
          disabled={stopping}
          className="px-8 py-2.5 rounded-xl bg-red-500 hover:bg-red-600 text-white font-semibold disabled:opacity-50 transition-colors"
        >
          {stopping ? '停止中…' : '⏹ 停止'}
        </button>
      </div>
    </div>
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
  const nowLocal = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
  const twoHoursAgo = new Date(now.getTime() - 2 * 3600000)
  const twoHoursAgoLocal = new Date(twoHoursAgo.getTime() - twoHoursAgo.getTimezoneOffset() * 60000).toISOString().slice(0, 16)

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
            <label className="block text-sm text-gray-500 mb-1">开始时间</label>
            <input
              type="datetime-local"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              className="input"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-500 mb-1">结束时间</label>
            <input
              type="datetime-local"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              className="input"
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
  const toLocalInput = (d: string) => {
    const date = new Date(d)
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
  }

  const [tagId, setTagId] = useState(entry.tagId)
  const [startTime, setStartTime] = useState(toLocalInput(entry.startTime))
  const [endTime, setEndTime] = useState(entry.endTime ? toLocalInput(entry.endTime) : '')
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
            <label className="block text-sm text-gray-500 mb-1">开始时间</label>
            <input type="datetime-local" value={startTime} onChange={(e) => setStartTime(e.target.value)} className="input" />
          </div>
          <div>
            <label className="block text-sm text-gray-500 mb-1">结束时间</label>
            <input
              type="datetime-local"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              placeholder={entry.endTime ? '' : '空表示进行中'}
              className="input"
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
  // 自定义时间：默认当前时间
  const nowLocal = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16)
  const [memoTime, setMemoTime] = useState(nowLocal)

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
        {/* 自定义时间 */}
        <div>
          <label className="block text-sm text-gray-500 mb-1">记事时间</label>
          <input
            type="datetime-local"
            value={memoTime}
            onChange={(e) => setMemoTime(e.target.value)}
            className="input"
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

        {/* 已上传文件预览列表 */}
        {attachments.length > 0 && (
          <div className="grid grid-cols-3 gap-2 pt-2">
            {attachments.map((att, idx) => (
              <div key={idx} className="relative group rounded-lg overflow-hidden border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800 h-20 flex items-center justify-center">
                {att.mimeType.startsWith('image/') ? (
                  <img src={att.path} alt={att.filename} className="w-full h-full object-cover" />
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
  const toLocalInput = (d: string) => {
    const date = new Date(d)
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
  }

  const [content, setContent] = useState(memo.content)
  const [memoTime, setMemoTime] = useState(toLocalInput(memo.createdAt))
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
          <label className="block text-sm text-gray-500 mb-1">记事时间</label>
          <input
            type="datetime-local"
            value={memoTime}
            onChange={(e) => setMemoTime(e.target.value)}
            className="input"
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
                  <img src={att.path} alt={att.filename} className="w-full h-full object-cover" />
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
