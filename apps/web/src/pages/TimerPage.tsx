import { useEffect, useState } from 'react'
import { useStore, formatClock } from '../store'
import { api } from '../api'
import type { TimeEntry, Tag } from '../types'
import { formatDuration } from '../store'

export default function TimerPage() {
  const { tags, categories, running, clockOffset, start, stop, stopAll, quickCount } = useStore()
  const [now, setNow] = useState(Date.now())
  const [recent, setRecent] = useState<TimeEntry[]>([])
  const [stoppingId, setStoppingId] = useState<string | null>(null)
  const [stoppingAll, setStoppingAll] = useState(false)
  const [showManual, setShowManual] = useState(false)
  const [editingEntry, setEditingEntry] = useState<TimeEntry | null>(null)
  const [filterCat, setFilterCat] = useState('')

  // 每秒刷新计时显示（有进行中的计时时）
  useEffect(() => {
    if (running.length === 0) return
    setNow(Date.now()) // 立即同步，避免显示旧时间
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [running.length])

  // 加载最近记录
  const loadRecent = async () => {
    const list = await api.timer.list().catch(() => [])
    setRecent(list)
  }

  useEffect(() => {
    loadRecent()
  }, [running.length])

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
      {recent.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
              最近记录
            </h2>
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
          <div className="space-y-2">
            {recent
              .filter((e) => !filterCat || (filterCat === 'none' ? !e.tag?.categoryId : e.tag?.categoryId === filterCat))
              .slice(0, 15)
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
          </div>
        </div>
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
function RunningTimer({ entry, elapsed, stopping, onStop }: {
  entry: TimeEntry
  elapsed: number
  stopping: boolean
  onStop: (note?: string) => void
}) {
  const [note, setNote] = useState(entry.note ?? '')
  const [noteSaved, setNoteSaved] = useState(false)

  const saveNote = async () => {
    await api.timer.update(entry.id, { note })
    setNoteSaved(true)
    setTimeout(() => setNoteSaved(false), 1500)
  }

  return (
    <div className="rounded-2xl border-2 border-brand-300 dark:border-brand-700 bg-brand-50 dark:bg-brand-900/20 p-6 text-center">
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
      {/* 备注编辑 */}
      <div className="flex gap-2 mb-4 max-w-sm mx-auto">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="添加备注…"
          className="input !py-1.5 text-sm"
        />
        <button
          onClick={saveNote}
          className="px-3 py-1.5 rounded-lg text-sm bg-brand-200 dark:bg-brand-800 text-brand-700 dark:text-brand-200 hover:bg-brand-300 whitespace-nowrap"
        >
          {noteSaved ? '✓ 已存' : '存备注'}
        </button>
      </div>
      <button
        onClick={() => onStop(note)}
        disabled={stopping}
        className="px-8 py-2.5 rounded-xl bg-red-500 hover:bg-red-600 text-white font-semibold disabled:opacity-50 transition-colors"
      >
        {stopping ? '停止中…' : '⏹ 停止'}
      </button>
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
