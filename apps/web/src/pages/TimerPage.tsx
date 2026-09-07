import { useEffect, useState, useMemo, useRef } from 'react'
import { useStore, formatClock, formatDuration, toIsoSafe } from '../store'
import { api, resolveUploadUrl } from '../api'
import type { TimeEntry, Tag, Todo, Memo, LinkedNoteEntry } from '../types'
import { DateTimeSecondPicker } from '../components/DateTimeSecondPicker'
import { syncNativeStatusBarTheme } from '../nativeStatusBar'

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
  const {
    tags,
    categories,
    running,
    pending,
    start,
    stop,
    stopAll,
    quickCount,
    resumeEntry,
    dismissPending,
    finishPending,
    terminateChain,
  } = useStore()
  const [todos, setTodos] = useState<Todo[]>([])
  const [quickTodoId, setQuickTodoId] = useState('')
  const [recent, setRecent] = useState<TimeEntry[]>([])
  const [stoppingId, setStoppingId] = useState<string | null>(null)
  const [stoppingAll, setStoppingAll] = useState(false)
  const [showManual, setShowManual] = useState(false)
  const [editingEntry, setEditingEntry] = useState<TimeEntry | null>(null)
  const [memoTargetEntry, setMemoTargetEntry] = useState<TimeEntry | null>(null)
  const [pointTargetEntry, setPointTargetEntry] = useState<TimeEntry | null>(null)
  const [showFullscreen, setShowFullscreen] = useState(false)
  const [filterCat, setFilterCat] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [showStopDialog, setShowStopDialog] = useState<{ entryId: string; tag: Tag } | null>(null)
  const [showResumeDialog, setShowResumeDialog] = useState<TimeEntry | null>(null)
  const [showDismissDialog, setShowDismissDialog] = useState<TimeEntry | null>(null)
  const [showActivityPicker, setShowActivityPicker] = useState<{ interruptedFromId?: string } | null>(null)
  const [showRecoveryDialog, setShowRecoveryDialog] = useState<TimeEntry | null>(null)
  const [showTerminateDialog, setShowTerminateDialog] = useState<TimeEntry | null>(null)
  // 最近记录日期范围：默认显示当天
  const [dateRange, setDateRange] = useState<'today' | 'yesterday' | '7days' | '30days' | 'custom'>('today')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [recentError, setRecentError] = useState('')
  const loadRecentSequence = useRef(0)

  const loadTodos = async () => {
    try {
      setTodos(await api.todos.list({ status: 'pending' }))
    } catch {
      // Todo 只是活动的可选关联，加载失败不应阻塞计时。
    }
  }

  useEffect(() => { void loadTodos() }, [])

  // 加载最近记录（按日期范围筛选）
  const loadRecent = async () => {
    const sequence = ++loadRecentSequence.current
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

    try {
      const list = await api.timer.list({ from, to })
      if (sequence !== loadRecentSequence.current) return
      setRecent(list)
      setRecentError('')
    } catch (e) {
      if (sequence !== loadRecentSequence.current) return
      // 保留当前时间线，避免临时网络错误被误显示成“暂无记录”。
      setRecentError(e instanceof Error ? e.message : '加载活动记录失败')
    }
  }

  useEffect(() => {
    void loadRecent()
  }, [running.length, dateRange, customFrom, customTo])

  const startActivity = async (tagId: string, todoId?: string, interruptedFromId?: string) => {
    const tag = tags.find((t) => t.id === tagId)
    if (tag?.trackType === 'count') {
      await quickCount(tagId, undefined, todoId || undefined)
    } else {
      await start(tagId, undefined, todoId || undefined, interruptedFromId)
    }
    await loadRecent()
  }

  const handleStart = async (tagId: string) => {
    try {
      await startActivity(tagId, quickTodoId || undefined)
    } catch (e) {
      alert((e as Error).message)
    }
  }

  const openNextRecovery = () => {
    const next = useStore.getState().pending[0]
    setShowRecoveryDialog(next ?? null)
  }

  const handleStop = async (id: string, note?: string) => {
    const entry = running.find(e => e.id === id)
    if (!entry) return

    // 有序 tag 弹窗选择
    if (entry.tag?.mode === 'ordered') {
      setShowStopDialog({ entryId: id, tag: entry.tag })
      return
    }

    // 混沌 tag 直接停止
    setStoppingId(id)
    try {
      await stop(id, note, false)
      await loadRecent()
      openNextRecovery()
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
      try {
        await api.timer.remove(id)
        await loadRecent()
      } catch (e) {
        alert(e instanceof Error ? e.message : '删除时间记录失败')
      }
    }
  }

  // 按分类分组标签
  const tagsByCategory = categories.map((cat) => ({
    category: cat,
    tags: tags.filter((t) => t.categoryId === cat.id),
  }))
  const uncategorized = tags.filter((t) => !t.categoryId)

  // 按结束时间倒序排序（进行中的在最上方，即 endTime 为 null 当作无穷大，已结束的按 endTime 倒序）
  const sortedRecent = useMemo(() => [...recent]
    .filter((e) => {
      if (filterCat && !(filterCat === 'none' ? !e.tag?.categoryId : e.tag?.categoryId === filterCat)) return false
      if (searchQuery) {
        const q = searchQuery.toLowerCase()
        const tagName = e.tag?.name?.toLowerCase() ?? ''
        const todoTitle = e.todo?.title?.toLowerCase() ?? ''
        const note = e.note?.toLowerCase() ?? ''
        const memoMatch = e.memos?.some((m) => m.content.toLowerCase().includes(q)) ?? false
        if (!tagName.includes(q) && !todoTitle.includes(q) && !note.includes(q) && !memoMatch) return false
      }
      return true
    })
    .sort((a, b) => {
      const timeA = a.endTime ? new Date(a.endTime).getTime() : Number.MAX_SAFE_INTEGER
      const timeB = b.endTime ? new Date(b.endTime).getTime() : Number.MAX_SAFE_INTEGER
      if (timeA !== timeB) return timeB - timeA
      return new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
    }), [recent, filterCat, searchQuery])

  return (
    <div className="space-y-6">
      {/* 暂存条 */}
      {pending.length > 0 && (
        <div className="rounded-xl border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-blue-700 dark:text-blue-300">⏸ 暂存待续（{pending.length}）</h3>
          </div>
          <div className="space-y-2">
            {pending.map((entry) => (
              <div
                key={entry.id}
                className="flex items-center justify-between bg-white dark:bg-gray-900 rounded-lg border border-blue-100 dark:border-blue-900 px-3 py-2"
              >
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: entry.tag?.color }} />
                  <span className="font-medium text-sm truncate">{entry.tag?.name}</span>
                  {entry.totalFocusedMs !== undefined && (
                    <span className="text-xs text-gray-500">· 专注 {formatDuration(entry.totalFocusedMs)}</span>
                  )}
                  {entry.note && <span className="text-xs text-gray-400 truncate">· {entry.note.slice(0, 30)}</span>}
                </div>
                <div className="flex gap-2 flex-shrink-0 ml-2">
                  <button
                    onClick={() => setShowResumeDialog(entry)}
                    className="text-xs px-2 py-1 rounded bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 hover:bg-blue-200"
                  >
                    续接
                  </button>
                  <button
                    onClick={() => setShowDismissDialog(entry)}
                    className="text-xs px-2 py-1 rounded text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
                  >
                    算了
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 进行中的计时卡片 */}
      {running.length > 0 ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <span className="text-sm text-gray-500">
              {running.length > 1 ? `${running.length} 个计时进行中` : '正在计时'}
            </span>
            <div className="flex items-center gap-3">
              <button
                onClick={() => {
                  const c = (window as any).Capacitor
                  if (!c?.isNativePlatform?.()) {
                    document.documentElement.requestFullscreen?.().catch(() => { /* noop */ })
                  }
                  setShowFullscreen(true)
                }}
                className="text-sm text-brand hover:underline"
                title="全屏常显：持续时长 + 当前时间 + 当前任务，屏幕不熄灭"
              >
                ⛶ 全屏常显
              </button>
              {running.length > 1 && (
                <button
                  onClick={handleStopAll}
                  disabled={stoppingAll}
                  className="text-sm text-red-500 hover:underline disabled:opacity-50"
                >
                  {stoppingAll ? '停止中…' : '全部停止'}
                </button>
              )}
            </div>
          </div>
          <div className={`grid gap-3 ${running.length >= 2 ? 'grid-cols-1 sm:grid-cols-2' : ''}`}>
            {running.map((entry) => (
              <RunningTimer
                key={entry.id}
                entry={entry}
                stopping={stoppingId === entry.id}
                onStop={(note) => handleStop(entry.id, note)}
                todos={todos}
                onTodoChange={async (todoId) => {
                  await api.timer.update(entry.id, { todoId: todoId || null })
                  await useStore.getState().loadRunning()
                }}
                onTerminate={() => setShowTerminateDialog(entry)}
                onAddMemo={() => setMemoTargetEntry(entry)}
                onAddPointRecord={() => setPointTargetEntry(entry)}
              />
            ))}
          </div>
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
        {todos.length > 0 && (
          <div className="mb-3 flex items-center gap-2 text-sm">
            <span className="text-gray-500 dark:text-gray-400">关联待办</span>
            <select
              value={quickTodoId}
              onChange={(e) => setQuickTodoId(e.target.value)}
              className="max-w-full input !w-auto !py-1.5 text-sm"
            >
              <option value="">不关联待办</option>
              {todos.map((todo) => <option key={todo.id} value={todo.id}>{todo.title}</option>)}
            </select>
          </div>
        )}
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
        {recentError && <div className="mb-3 text-xs text-red-500">{recentError}</div>}
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide flex items-center gap-1.5">
              <span>📅 活动时间线</span>
              <span className="text-xs font-normal text-gray-400">（按结束时间倒序）</span>
            </h2>
          </div>
          <div className="flex w-full items-center gap-2 flex-wrap sm:w-auto">
            {/* 搜索框 */}
            <div className="relative w-full sm:w-auto">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索活动/待办/备注/打点…"
                className="w-full text-xs border border-gray-200 dark:border-gray-800 rounded-lg pl-7 pr-2 py-1 bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300 sm:w-36 sm:focus:w-48 transition-all focus:outline-none focus:border-brand"
              />
              <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-xs">🔍</span>
            </div>
            {/* 日期范围快捷选项 */}
            <div className="flex max-w-full gap-1 overflow-x-auto pb-1 sm:overflow-visible sm:pb-0">
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
                  className={`shrink-0 px-2 py-1 rounded-full text-xs ${dateRange === r.key ? 'bg-brand-100 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300' : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'}`}
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
          todos={todos}
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
          todos={todos}
          onClose={() => setEditingEntry(null)}
          onSaved={async () => {
            setEditingEntry(null)
            await loadRecent()
          }}
        />
      )}

      {/* 有序 tag 停止选择弹窗 */}
      {showStopDialog && (
        <StopDialog
          entryId={showStopDialog.entryId}
          tag={showStopDialog.tag}
          onClose={() => setShowStopDialog(null)}
          onConfirm={async (pendingResume, note) => {
            setStoppingId(showStopDialog.entryId)
            try {
              await stop(showStopDialog.entryId, note, pendingResume)
              if (pendingResume) {
                setShowActivityPicker({ interruptedFromId: showStopDialog.entryId })
              } else {
                openNextRecovery()
              }
              await loadRecent()
            } catch (e) {
              alert((e as Error).message)
            } finally {
              setStoppingId(null)
            }
          }}
        />
      )}

      {/* 续接弹窗 */}
      {showResumeDialog && (
        <ResumeDialog
          entry={showResumeDialog}
          onClose={() => setShowResumeDialog(null)}
          onConfirm={async () => {
            await resumeEntry(showResumeDialog.id)
            await loadRecent()
          }}
        />
      )}

      {showActivityPicker && (
        <ActivityPickerDialog
          tags={tags}
          todos={todos}
          interruptedFromId={showActivityPicker.interruptedFromId}
          onClose={() => setShowActivityPicker(null)}
          onStart={async (tagId, todoId) => {
            await startActivity(tagId, todoId, showActivityPicker.interruptedFromId)
          }}
        />
      )}

      {showRecoveryDialog && (
        <RecoveryDialog
          entries={pending}
          onClose={() => setShowRecoveryDialog(null)}
          onResume={async (entry) => {
            await resumeEntry(entry.id)
            setShowRecoveryDialog(null)
            await loadRecent()
          }}
          onFinish={async (entry) => {
            await finishPending(entry.id)
            openNextRecovery()
          }}
          onStartAnother={(entry) => {
            setShowRecoveryDialog(null)
            setShowActivityPicker({ interruptedFromId: entry.id })
          }}
        />
      )}

      {showTerminateDialog && (
        <TerminateDialog
          entry={showTerminateDialog}
          onClose={() => setShowTerminateDialog(null)}
          onConfirm={async (reason) => {
            await terminateChain(showTerminateDialog.id, reason)
            setShowTerminateDialog(null)
            await loadRecent()
          }}
        />
      )}

      {/* 放弃暂存弹窗 */}
      {showDismissDialog && (
        <DismissDialog
          entry={showDismissDialog}
          onClose={() => setShowDismissDialog(null)}
          onConfirm={async (reason) => {
            await dismissPending(showDismissDialog.id, reason)
          }}
        />
      )}

      {/* 全屏常显时钟 */}
      {showFullscreen && <FullscreenClockOverlay onClose={() => setShowFullscreen(false)} />}
    </div>
  )
}

// ===== 全屏常显时钟（手机端：持续时长 + 当前任务 + 当前时间，屏幕不熄灭）=====
function FullscreenClockOverlay({ onClose }: { onClose: () => void }) {
  const running = useStore((s) => s.running)
  const clockOffset = useStore((s) => s.clockOffset)
  const [now, setNow] = useState(Date.now())
  const [wakeLocked, setWakeLocked] = useState(false)
  const [isPortrait, setIsPortrait] = useState(
    typeof window !== 'undefined' ? window.matchMedia('(orientation: portrait)').matches : true
  )

  // 监听横竖屏切换，动态调整布局
  useEffect(() => {
    const mq = window.matchMedia('(orientation: portrait)')
    const onChange = (e: MediaQueryListEvent) => setIsPortrait(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  // 每秒刷新
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  // 屏幕常亮：Wake Lock，切后台回来自动重新获取
  useEffect(() => {
    let sentinel: any = null
    let cancelled = false
    const acquire = async () => {
      try {
        const wl = (navigator as any).wakeLock
        if (!wl) return
        sentinel = await wl.request('screen')
        setWakeLocked(true)
        sentinel?.addEventListener?.('release', () => setWakeLocked(false))
      } catch {
        /* 权限被拒或环境不支持时静默降级 */
      }
    }
    acquire()
    const onVisible = () => {
      if (!cancelled && document.visibilityState === 'visible') acquire()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
      try { sentinel?.release?.() } catch { /* noop */ }
    }
  }, [])

  // 进入全屏，退出时恢复
  // 浏览器的 requestFullscreen 已在按钮点击手势中同步调用（此处不再重复）
  // 原生端隐藏系统状态栏；同时隐藏页头并锁定 body（见 index.css fullscreen-clock-active）
  useEffect(() => {
    const Capacitor = (window as any).Capacitor
    const isNative = Boolean(Capacitor?.isNativePlatform?.())
    document.body.classList.add('fullscreen-clock-active')

    const hideNativeStatusBar = async () => {
      try {
        if (!isNative) return
        const { StatusBar } = await import('@capacitor/status-bar')
        try { await StatusBar.setOverlaysWebView({ overlay: false }) } catch { /* noop */ }
        await StatusBar.hide()
      } catch { /* noop */ }
    }
    hideNativeStatusBar()

    return () => {
      document.body.classList.remove('fullscreen-clock-active')
      if (document.fullscreenElement) document.exitFullscreen().catch(() => { /* noop */ })
      if (isNative) {
          import('@capacitor/status-bar')
          .then(async ({ StatusBar }) => {
            await StatusBar.show()
            await syncNativeStatusBarTheme()
            window.dispatchEvent(new Event('resize'))
          })
          .catch(() => { /* noop */ })
      }
    }
  }, [])

  const wallTime = new Date(now)
  const count = running.length

  // 布局（方向感知）：竖屏 2个上下堆叠 / 3个上通栏+下左右；横屏 2个左右 / 3个左右+下中；4个均为田字格
  const gridClass =
    count === 1 ? 'grid-cols-1 grid-rows-1'
    : count === 2 ? (isPortrait ? 'grid-cols-1 grid-rows-2' : 'grid-cols-2 grid-rows-1')
    : count === 3 ? 'grid-cols-2 grid-rows-2'
    : 'grid-cols-2'

  // 字号随任务数与方向自适应（时钟 8 个等宽字符宽 ≈ 4.8 倍字号，需同时容纳于格子宽度与高度）
  const clockSize =
    count === 1 ? 'min(19vw, 50vh)'
    : count === 2 ? (isPortrait ? 'min(19vw, 22vh)' : 'min(9.5vw, 40vh)')
    : count === 3 ? (isPortrait ? 'min(9.5vw, 20vh)' : 'min(9.5vw, 28vh)')
    : count === 4 ? (isPortrait ? 'min(9.5vw, 20vh)' : 'min(9.5vw, 24vh)')
    : 'min(8.5vw, 16vh)'
  const nameSize =
    count === 1 ? 'min(6vw, 5vh)'
    : count === 2 ? (isPortrait ? 'min(5vw, 3.5vh)' : 'min(4.5vw, 3.5vh)')
    : count === 3 ? 'min(4vw, 3vh)'
    : 'min(3.5vw, 2.5vh)'

  return (
    <div
      className="fixed inset-0 z-[100] bg-black text-white flex flex-col select-none"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      {/* 顶部状态 */}
      <div className="flex items-center justify-between px-5 pt-4 pb-1 text-sm text-gray-500 shrink-0">
        <span className="flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full ${count > 0 ? 'bg-green-500 animate-pulse' : 'bg-gray-600'}`}
          />
          {count > 0 ? `${count} 个计时进行中` : '未在计时'}
          {wakeLocked && <span className="text-xs text-gray-600">· 屏幕常亮</span>}
        </span>
        <button onClick={onClose} className="text-gray-400 hover:text-white text-lg leading-none p-2" title="退出全屏">
          ✕
        </button>
      </div>

      {/* 中部：任务网格，每格尽量占满 */}
      <div className={`flex-1 min-h-0 w-full grid gap-x-2 gap-y-4 px-2 py-2 ${gridClass} ${count > 4 ? 'overflow-y-auto' : ''}`}>
        {count === 0 ? (
          <div className="col-span-full flex flex-col items-center justify-center text-gray-500 space-y-3">
            <div className="text-6xl">⏱</div>
            <div className="text-lg">未在计时</div>
            <div className="text-xs text-gray-600">回 App 选择标签开始</div>
          </div>
        ) : (
          running.map((entry, i) => {
            const elapsed = Math.max(0, (now - clockOffset) - new Date(entry.startTime).getTime())
            const color = entry.tag?.color ?? '#6d5efc'
            return (
              <div
                key={entry.id}
                className={`flex flex-col items-center justify-center text-center min-h-0 min-w-0 p-2 ${count === 3 && (isPortrait ? i === 0 : i === 2) ? 'col-span-2' : ''}`}
              >
                <div className="flex items-center justify-center gap-2 mb-2 flex-wrap min-w-0">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: color }} />
                  <span className="font-medium truncate max-w-[46vw]" style={{ color, fontSize: nameSize }}>
                    {entry.tag?.icon ? `${entry.tag.icon} ` : ''}{entry.tag?.name}
                  </span>
                  {entry.tag?.category && count <= 3 && (
                    <span
                      className="px-2 py-0.5 rounded-full border shrink-0"
                      style={{
                        fontSize: 'min(2.5vw, 2.2vh)',
                        backgroundColor: `${entry.tag.category.color}22`,
                        color: entry.tag.category.color,
                        borderColor: `${entry.tag.category.color}55`,
                      }}
                    >
                      {entry.tag.category.icon ? `${entry.tag.category.icon} ` : ''}
                      {entry.tag.category.name}
                    </span>
                  )}
                </div>
                <div
                  className="font-mono font-bold tabular-nums leading-none"
                  style={{ color, fontSize: clockSize }}
                >
                  {formatClock(elapsed)}
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* 底部：当前时间（保持字号，压缩高度给任务区让空间） */}
      <div className="shrink-0 text-center pb-5 pt-1">
        <div className="text-6xl font-mono font-light tabular-nums text-gray-100 leading-tight">
          {wallTime.toLocaleTimeString('zh-CN', { hour12: false })}
        </div>
        <div className="mt-1 text-sm text-gray-500">
          {wallTime.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}
        </div>
      </div>
    </div>
  )
}

// 进行中计时卡片（内部自带每秒时钟，避免整页重渲染）
function RunningTimer({ entry, stopping, todos, onStop, onTodoChange, onTerminate, onAddMemo, onAddPointRecord }: {
  entry: TimeEntry
  stopping: boolean
  todos: Todo[]
  onStop: (note?: string) => void
  onTodoChange: (todoId: string) => Promise<void>
  onTerminate: () => void
  onAddMemo: () => void
  onAddPointRecord: () => void
}) {
  const clockOffset = useStore((s) => s.clockOffset)
  const [note, setNote] = useState(entry.note ?? '')
  const [noteSaved, setNoteSaved] = useState(false)
  const [todoSaving, setTodoSaving] = useState(false)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const elapsed = Math.max(0, (now - clockOffset) - new Date(entry.startTime).getTime())

  const saveNote = async () => {
    try {
      await api.timer.update(entry.id, { note })
      setNoteSaved(true)
      setTimeout(() => setNoteSaved(false), 1500)
    } catch (e) {
      alert(e instanceof Error ? e.message : '保存备注失败')
    }
  }

  const changeTodo = async (todoId: string) => {
    setTodoSaving(true)
    try {
      await onTodoChange(todoId)
    } catch (e) {
      alert(e instanceof Error ? e.message : '关联待办失败')
    } finally {
      setTodoSaving(false)
    }
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
      <div className="flex items-center justify-center gap-2 mb-4">
        <span className="text-xs text-gray-500 dark:text-gray-400">待办</span>
        <select
          value={entry.todoId ?? ''}
          disabled={todoSaving}
          onChange={(e) => void changeTodo(e.target.value)}
          className="max-w-[min(22rem,80vw)] input !w-auto !py-1.5 text-xs"
        >
          <option value="">不关联待办</option>
          {todos.map((todo) => <option key={todo.id} value={todo.id}>{todo.title}</option>)}
        </select>
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
      <div className="flex justify-center items-center gap-3 flex-wrap">
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
        <button
          type="button"
          onClick={onTerminate}
          className="px-3 py-2.5 rounded-xl border border-red-300 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 text-sm transition-colors"
          title="终止当前活动及其接管链，必须填写原因"
        >
          ⚠ 终止链路
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
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
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
              {entry.todo && (
                <span className="text-xs px-2.5 py-0.5 rounded-full bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 font-medium truncate max-w-[18rem]" title={entry.todo.title}>
                  待办：{entry.todo.title}
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
          <div className="flex min-w-0 flex-wrap items-center gap-2 sm:flex-shrink-0 sm:justify-end">
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
    const pointIso = toIsoSafe(pointTime)
    if (!pointIso) {
      setError('请选择有效的打点时间')
      return
    }
    setError('')
    try {
      await api.memos.create({
        content: content.trim(),
        type: 'point',
        timeEntryId: entry.id,
        tagId: entry.tagId,
        createdAt: pointIso,
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
          <DateTimeSecondPicker value={pointTime} onChange={setPointTime} />
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
function ManualEntryModal({ tags, categories, todos, onClose, onSaved }: {
  tags: Tag[]
  categories: { id: string; name: string; color: string }[]
  todos: Todo[]
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
  const [todoId, setTodoId] = useState('')
  const [error, setError] = useState('')

  const save = async () => {
    setError('')
    if (!tagId) {
      setError('请选择标签')
      return
    }
    const startIso = toIsoSafe(startTime)
    const endIso = toIsoSafe(endTime)
    if (!startIso || !endIso) {
      setError('请填写有效的开始/结束时间')
      return
    }
    if (new Date(endIso) <= new Date(startIso)) {
      setError('结束时间必须晚于开始时间')
      return
    }
    try {
      await api.timer.manual({
        tagId,
        startTime: startIso,
        endTime: endIso,
        note: note || undefined,
        todoId: todoId || undefined,
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
        {todos.length > 0 && (
          <div>
            <label className="block text-sm text-gray-500 mb-1">关联待办（可选）</label>
            <select value={todoId} onChange={(e) => setTodoId(e.target.value)} className="input">
              <option value="">不关联待办</option>
              {todos.map((todo) => <option key={todo.id} value={todo.id}>{todo.title}</option>)}
            </select>
          </div>
        )}
        {error && <div className="text-sm text-red-500">{error}</div>}
      </div>
      <FormActions onCancel={onClose} onSave={save} saveLabel="补录" />
    </ModalShell>
  )
}

// 编辑记录弹窗
function EntryEditModal({ entry, tags, todos, onClose, onSaved }: {
  entry: TimeEntry
  tags: Tag[]
  todos: Todo[]
  onClose: () => void
  onSaved: () => void
}) {
  const [tagId, setTagId] = useState(entry.tagId)
  const [startTime, setStartTime] = useState(toLocalInputWithSeconds(entry.startTime))
  const [endTime, setEndTime] = useState(entry.endTime ? toLocalInputWithSeconds(entry.endTime) : '')
  const [note, setNote] = useState(entry.note ?? '')
  const [todoId, setTodoId] = useState(entry.todoId ?? '')
  const [error, setError] = useState('')

  // 次数型标签的记录 startTime === endTime（零时长打卡），编辑时需同步起止时间
  // 兼容 tags 尚未加载或标签已删除的情况，回退到 entry 自带的 tag
  const isCountEntry = (tags.find((t) => t.id === tagId)?.trackType ?? (entry as any).tag?.trackType) === 'count'

  const handleStartChange = (value: string) => {
    setStartTime(value)
    if (isCountEntry && endTime) setEndTime(value)
  }

  const save = async () => {
    setError('')
    const startIso = toIsoSafe(startTime)
    if (!startIso) {
      setError('请填写有效的开始时间')
      return
    }
    let endIso: string | null = null
    if (endTime) {
      endIso = toIsoSafe(endTime)
      if (!endIso) {
        setError('请填写有效的结束时间')
        return
      }
    }
    if (!isCountEntry && endIso && new Date(endIso) <= new Date(startIso)) {
      setError('结束时间必须晚于开始时间')
      return
    }
    try {
      await api.timer.update(entry.id, {
        tagId,
        startTime: startIso,
        endTime: endIso,
        note,
        todoId: todoId || null,
      })
      useStore.getState().loadRunning()
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
            <DateTimeSecondPicker value={startTime} onChange={handleStartChange} />
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-sm text-gray-500">结束时间 (带秒)</label>
              {endTime && (
                <button
                  onClick={() => setEndTime('')}
                  className="text-xs text-red-500 hover:underline"
                  title="清除结束时间，保存后该活动将恢复为进行中"
                >
                  ✕ 清除
                </button>
              )}
            </div>
            {endTime ? (
              <DateTimeSecondPicker value={endTime} onChange={setEndTime} />
            ) : (
              <div className="flex items-center justify-between gap-2 h-[42px]">
                <span className="text-xs text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800 px-2.5 py-1.5 rounded-lg">
                  ● 保存后恢复为进行中
                </span>
                <button
                  onClick={() => setEndTime(toLocalInputWithSeconds(new Date()))}
                  className="text-xs text-brand hover:underline whitespace-nowrap"
                >
                  撤销清除
                </button>
              </div>
            )}
          </div>
        </div>
        <div>
          <label className="block text-sm text-gray-500 mb-1">备注</label>
          <input value={note} onChange={(e) => setNote(e.target.value)} className="input" />
        </div>
        {todos.length > 0 && (
          <div>
            <label className="block text-sm text-gray-500 mb-1">关联待办（可选）</label>
            <select value={todoId} onChange={(e) => setTodoId(e.target.value)} className="input">
              <option value="">不关联待办</option>
              {todos.map((todo) => <option key={todo.id} value={todo.id}>{todo.title}</option>)}
            </select>
          </div>
        )}
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
      const results = await Promise.all(Array.from(files).map((f) => api.memos.upload(f)))
      setAttachments((prev) => [...prev, ...results])
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setUploading(false)
      e.target.value = ''
    }
  }

  const save = async () => {
    if (!content.trim() && attachments.length === 0) {
      setError('请输入记事内容或上传文件')
      return
    }
    const memoIso = toIsoSafe(memoTime)
    if (!memoIso) {
      setError('请选择有效的记事时间')
      return
    }
    setError('')
    try {
      await api.memos.create({
        content: content.trim() || '（无文字附记）',
        type: 'diary',
        timeEntryId: entry.id,
        tagId: entry.tagId,
        createdAt: memoIso,
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
          <DateTimeSecondPicker value={memoTime} onChange={setMemoTime} />
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
  onOpenNote,
}: {
  memo: Memo
  onClose: () => void
  onSaved: () => void
  onOpenNote?: (id: string) => void
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
  const [linkedNotes, setLinkedNotes] = useState<LinkedNoteEntry[]>([])
  const linkedNotesRequest = useRef(0)

  // 反查：挂靠到本日记 [[memo:<id>]] 的笔记
  useEffect(() => {
    const sequence = ++linkedNotesRequest.current
    setLinkedNotes([])
    api.notes.linked('memo', memo.id)
      .then((notes) => { if (sequence === linkedNotesRequest.current) setLinkedNotes(notes) })
      .catch(() => { if (sequence === linkedNotesRequest.current) setLinkedNotes([]) })
  }, [memo.id])

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return
    setUploading(true)
    setError('')
    try {
      const results = await Promise.all(Array.from(files).map((f) => api.memos.upload(f)))
      setAttachments((prev) => [...prev, ...results])
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setUploading(false)
      e.target.value = ''
    }
  }

  const save = async () => {
    if (!content.trim() && attachments.length === 0) {
      setError('请输入记事内容或上传文件')
      return
    }
    const memoIso = toIsoSafe(memoTime)
    if (!memoIso) {
      setError('请选择有效的记事时间')
      return
    }
    setError('')
    try {
      await api.memos.update(memo.id, {
        content: content.trim() || '（无文字附记）',
        createdAt: memoIso,
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
          <DateTimeSecondPicker value={memoTime} onChange={setMemoTime} />
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

        {linkedNotes.length > 0 && (
          <div>
            <label className="block text-sm text-gray-500 mb-1">📝 关联笔记</label>
            <div className="flex flex-wrap gap-1.5">
              {linkedNotes.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => onOpenNote?.(n.id)}
                  className="text-xs text-brand hover:underline bg-brand/5 rounded px-2 py-1 truncate max-w-[200px]"
                  title={n.title}
                >
                  {n.title}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <FormActions onCancel={onClose} onSave={save} saveLabel="保存修改" />
    </ModalShell>
  )
}

// 暂停后选择下一活动
function ActivityPickerDialog({ tags, todos, interruptedFromId, onClose, onStart }: {
  tags: Tag[]
  todos: Todo[]
  interruptedFromId?: string
  onClose: () => void
  onStart: (tagId: string, todoId?: string) => Promise<void>
}) {
  const timeTags = tags.filter((tag) => tag.trackType === 'time')
  const [tagId, setTagId] = useState(timeTags[0]?.id ?? '')
  const [todoId, setTodoId] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleStart = async () => {
    if (!tagId) {
      setError('请选择一个时长型活动')
      return
    }
    setLoading(true)
    setError('')
    try {
      await onStart(tagId, todoId || undefined)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : '开始活动失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <ModalShell title={interruptedFromId ? '选择接下来做什么' : '选择活动'} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          原活动已经暂存，可以现在开始下一项，也可以稍后再处理。
        </p>
        <div>
          <label className="block text-sm text-gray-500 mb-1">活动</label>
          <select value={tagId} onChange={(e) => setTagId(e.target.value)} className="input">
            <option value="">请选择活动…</option>
            {timeTags.map((tag) => (
              <option key={tag.id} value={tag.id}>{tag.icon ? `${tag.icon} ` : ''}{tag.name}</option>
            ))}
          </select>
        </div>
        {todos.length > 0 && (
          <div>
            <label className="block text-sm text-gray-500 mb-1">关联待办（可选）</label>
            <select value={todoId} onChange={(e) => setTodoId(e.target.value)} className="input">
              <option value="">不关联待办</option>
              {todos.map((todo) => <option key={todo.id} value={todo.id}>{todo.title}</option>)}
            </select>
          </div>
        )}
        {timeTags.length === 0 && <div className="text-sm text-gray-500">当前没有可计时的时长型活动。</div>}
        {error && <div className="text-sm text-red-500">{error}</div>}
        <div className="flex gap-2 pt-2">
          <button
            onClick={() => void handleStart()}
            disabled={loading || timeTags.length === 0}
            className="flex-1 px-4 py-2.5 rounded-xl bg-brand text-white font-medium hover:bg-brand-600 disabled:opacity-50"
          >
            {loading ? '开始中…' : '开始活动'}
          </button>
          <button onClick={onClose} disabled={loading} className="px-4 py-2.5 rounded-xl border border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800">
            稍后处理
          </button>
        </div>
      </div>
    </ModalShell>
  )
}

// 当前活动结束后的待续回退选择
function RecoveryDialog({ entries, onClose, onResume, onFinish, onStartAnother }: {
  entries: TimeEntry[]
  onClose: () => void
  onResume: (entry: TimeEntry) => Promise<void>
  onFinish: (entry: TimeEntry) => Promise<void>
  onStartAnother: (entry: TimeEntry) => void
}) {
  const [selectedId, setSelectedId] = useState(entries[0]?.id ?? '')
  const [loading, setLoading] = useState(false)
  const selected = entries.find((entry) => entry.id === selectedId) ?? entries[0]

  if (!selected) return null

  const run = async (action: (entry: TimeEntry) => Promise<void>) => {
    setLoading(true)
    try {
      await action(selected)
    } catch (e) {
      alert(e instanceof Error ? e.message : '处理待续活动失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <ModalShell title="接下来处理哪个活动？" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          当前活动已经结束，暂存中的活动还没有丢失。
        </p>
        {entries.length > 1 && (
          <div>
            <label className="block text-sm text-gray-500 mb-1">选择待续活动</label>
            <select value={selected.id} onChange={(e) => setSelectedId(e.target.value)} className="input">
              {entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.tag?.name} · {entry.note || '无续接备注'}</option>)}
            </select>
          </div>
        )}
        <div className="rounded-lg bg-blue-50 dark:bg-blue-900/20 p-3">
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full" style={{ background: selected.tag?.color }} />
            <span className="font-medium">{selected.tag?.name}</span>
          </div>
          <div className="text-sm text-gray-500 dark:text-gray-400 mt-2 whitespace-pre-wrap">{selected.note || '没有留下续接备注'}</div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button onClick={() => void run(onResume)} disabled={loading} className="px-3 py-2.5 rounded-xl bg-blue-500 text-white font-medium hover:bg-blue-600 disabled:opacity-50">继续活动</button>
          <button onClick={() => onStartAnother(selected)} disabled={loading} className="px-3 py-2.5 rounded-xl bg-brand text-white font-medium hover:bg-brand-600 disabled:opacity-50">开始新活动</button>
          <button onClick={() => void run(onFinish)} disabled={loading} className="px-3 py-2.5 rounded-xl border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50">结束此活动</button>
          <button onClick={onClose} disabled={loading} className="px-3 py-2.5 rounded-xl text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50">稍后处理</button>
        </div>
      </div>
    </ModalShell>
  )
}

// 终止本次链路：高警戒、原因必填
function TerminateDialog({ entry, onClose, onConfirm }: {
  entry: TimeEntry
  onClose: () => void
  onConfirm: (reason: string) => Promise<void>
}) {
  const [reason, setReason] = useState('')
  const [loading, setLoading] = useState(false)

  const confirm = async () => {
    if (!reason.trim()) {
      alert('必须填写终止本次链路的具体原因')
      return
    }
    setLoading(true)
    try {
      await onConfirm(reason.trim())
    } catch (e) {
      alert(e instanceof Error ? e.message : '终止链路失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <ModalShell title="终止本次链路" onClose={onClose}>
      <div className="space-y-4">
        <div className="rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-700 dark:text-red-300">
          这会结束当前活动，并一并结束它接管过的上游活动。已有时间记录会保留，但这条链路不会再自动回收。
        </div>
        <div className="text-sm text-gray-600 dark:text-gray-300">当前活动：{entry.tag?.name}</div>
        <div>
          <label className="block text-sm text-gray-500 mb-1">具体原因 *</label>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} className="input resize-y" placeholder="例如：需求取消，今天不再继续这组工作" autoFocus />
        </div>
        <div className="flex gap-2 pt-2">
          <button onClick={() => void confirm()} disabled={loading} className="flex-1 px-4 py-2.5 rounded-xl bg-red-600 text-white font-semibold hover:bg-red-700 disabled:opacity-50">{loading ? '终止中…' : '确认终止链路'}</button>
          <button onClick={onClose} disabled={loading} className="px-4 py-2.5 rounded-xl border border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800">取消</button>
        </div>
      </div>
    </ModalShell>
  )
}

// 有序 tag 停止选择弹窗
function StopDialog({ entryId, tag, onClose, onConfirm }: {
  entryId: string
  tag: Tag
  onClose: () => void
  onConfirm: (pendingResume: boolean, note?: string) => Promise<void>
}) {
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(false)

  const handleConfirm = async (pendingResume: boolean) => {
    if (pendingResume && !note.trim()) {
      alert('有序标签暂停时需要记一下接下来怎么续')
      return
    }
    setLoading(true)
    try {
      await onConfirm(pendingResume, note.trim() || undefined)
      onClose()
    } catch (e) {
      alert((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <ModalShell onClose={onClose} title="接下来怎么续？">
      <div className="space-y-4">
        <div className="flex items-center gap-2 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
          <span className="w-3 h-3 rounded-full" style={{ background: tag.color }} />
          <span className="font-medium">{tag.name}</span>
          <span className="text-xs px-2 py-0.5 rounded bg-blue-100 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400">有序模式</span>
        </div>
        <div>
          <label className="block text-sm text-gray-500 mb-1">下一步怎么续（暂停时必填）</label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="写一句回来后马上能接上的提示…"
            className="input min-h-20 resize-y"
          />
        </div>
        <div className="flex flex-col gap-2 pt-2">
          <button
            onClick={() => handleConfirm(true)}
            disabled={loading}
            className="w-full px-4 py-3 rounded-xl bg-blue-500 text-white font-medium hover:bg-blue-600 disabled:opacity-50"
          >
            ⏸ 暂停
          </button>
          <button
            onClick={() => handleConfirm(false)}
            disabled={loading}
            className="w-full px-4 py-3 rounded-xl bg-red-500 text-white font-medium hover:bg-red-600 disabled:opacity-50"
          >
            ⏹ 直接结束
          </button>
          <button
            onClick={onClose}
            disabled={loading}
            className="w-full px-4 py-2 text-gray-500 hover:text-gray-700 text-sm"
          >
            取消
          </button>
        </div>
      </div>
    </ModalShell>
  )
}

// 续接弹窗
function ResumeDialog({ entry, onClose, onConfirm }: {
  entry: TimeEntry
  onClose: () => void
  onConfirm: () => Promise<void>
}) {
  const [loading, setLoading] = useState(false)

  const handleConfirm = async () => {
    setLoading(true)
    try {
      await onConfirm()
      onClose()
    } catch (e) {
      alert((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <ModalShell onClose={onClose} title={`接续：${entry.tag?.name ?? '任务'}`}>
      <div className="space-y-4">
        <div className="flex items-center gap-2 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
          <span className="w-3 h-3 rounded-full" style={{ background: entry.tag?.color }} />
          <span className="font-medium">{entry.tag?.name}</span>
        </div>
        <div>
          <label className="block text-sm text-gray-500 mb-1">接下来怎么续</label>
          <div className="input min-h-20 whitespace-pre-wrap text-gray-600 dark:text-gray-300">
            {entry.note || '（没有备注）'}
          </div>
        </div>
        <div className="flex gap-2 pt-2">
          <button
            onClick={handleConfirm}
            disabled={loading}
            className="flex-1 px-4 py-2.5 rounded-xl bg-blue-500 text-white font-medium hover:bg-blue-600 disabled:opacity-50"
          >
            {loading ? '接续中…' : '接续此任务'}
          </button>
          <button
            onClick={onClose}
            disabled={loading}
            className="px-4 py-2.5 rounded-xl border border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            取消
          </button>
        </div>
      </div>
    </ModalShell>
  )
}

// 算了弹窗
function DismissDialog({ entry, onClose, onConfirm }: {
  entry: TimeEntry
  onClose: () => void
  onConfirm: (reason: string) => Promise<void>
}) {
  const [reason, setReason] = useState('')
  const [loading, setLoading] = useState(false)

  const handleConfirm = async () => {
    if (!reason.trim()) {
      alert('请输入算了的原因')
      return
    }
    setLoading(true)
    try {
      await onConfirm(reason)
      onClose()
    } catch (e) {
      alert((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <ModalShell onClose={onClose} title="这件事算了不续了 ——">
      <div className="space-y-4">
        <div className="flex items-center gap-2 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
          <span className="w-3 h-3 rounded-full" style={{ background: entry.tag?.color }} />
          <span className="font-medium">{entry.tag?.name}</span>
        </div>
        <div>
          <label className="block text-sm text-gray-500 mb-1">原因 *</label>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="如：不重要、已完成、计划变更…"
            className="input"
          />
        </div>
        <div className="flex gap-2 pt-2">
          <button
            onClick={handleConfirm}
            disabled={loading}
            className="flex-1 px-4 py-2.5 rounded-xl bg-gray-500 text-white font-medium hover:bg-gray-600 disabled:opacity-50"
          >
            {loading ? '处理中…' : '算了'}
          </button>
          <button
            onClick={onClose}
            disabled={loading}
            className="px-4 py-2.5 rounded-xl border border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            取消
          </button>
        </div>
      </div>
    </ModalShell>
  )
}
