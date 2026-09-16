import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import type { Todo } from '../types'
import DiaryPanel from '../components/DiaryPanel'

const PRIORITY = [
  { value: 0, label: '普通', color: 'text-gray-400' },
  { value: 1, label: '重要', color: 'text-amber-500' },
  { value: 2, label: '紧急', color: 'text-red-500' },
]

type ActivityView = 'current' | 'all' | 'completed'
type ActivityCycle = 'daily' | 'weekly' | 'monthly'

const ACTIVITY_NOTIFICATION_START = 2000
const ACTIVITY_NOTIFICATION_END = 2099

async function syncActivityNotifications(todos: Todo[]) {
  const isNative = typeof window !== 'undefined' && Boolean((window as any).Capacitor?.isNativePlatform?.())
  if (!isNative) return
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications')
    const permission = await LocalNotifications.checkPermissions()
    if (permission.display !== 'granted') {
      const requested = await LocalNotifications.requestPermissions()
      if (requested.display !== 'granted') return
    }

    await LocalNotifications.cancel({
      notifications: Array.from({ length: ACTIVITY_NOTIFICATION_END - ACTIVITY_NOTIFICATION_START + 1 }, (_, index) => ({
        id: ACTIVITY_NOTIFICATION_START + index,
      })),
    })

    const now = Date.now()
    const notifications = todos
      .filter((todo) => todo.status === 'pending' && todo.dueDate)
      .sort((a, b) => new Date(a.dueDate!).getTime() - new Date(b.dueDate!).getTime())
      .slice(0, 50)
      .flatMap((todo, index) => {
        const due = new Date(todo.dueDate!)
        const reminder = new Date(due.getTime() - 60 * 60 * 1000)
        const result = []
        if (reminder.getTime() > now + 30_000) {
          result.push({
            id: ACTIVITY_NOTIFICATION_START + index * 2,
            title: `活动提醒 · ${todo.title}`,
            body: '距离截止还有 1 小时',
            schedule: { at: reminder },
            autoCancel: true,
          })
        }
        if (due.getTime() > now + 30_000) {
          result.push({
            id: ACTIVITY_NOTIFICATION_START + index * 2 + 1,
            title: `活动到期 · ${todo.title}`,
            body: '活动尚未完成，超时完成时需要填写原因',
            schedule: { at: due },
            autoCancel: true,
          })
        }
        return result
      })
    if (notifications.length > 0) await LocalNotifications.schedule({ notifications })
  } catch (error) {
    console.warn('Activity notification sync warn:', error)
  }
}

function formatDate(d: Date) {
  return d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' })
}

function isSameLocalDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate()
}

function currentCycleRange(cycle: ActivityCycle, now = new Date()): { start: Date; end: Date } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (cycle === 'daily') return { start, end: new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1) }
  if (cycle === 'monthly') return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: new Date(now.getFullYear(), now.getMonth() + 1, 1) }
  const day = start.getDay() || 7
  start.setDate(start.getDate() - day + 1)
  return { start, end: new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7) }
}

function isInCurrentCycle(todo: Todo, cycle: ActivityCycle): boolean {
  if (!todo.dueDate) return false
  const due = new Date(todo.dueDate)
  const range = currentCycleRange(cycle)
  return due >= range.start && due < range.end
}

function sortActivityItems(items: Todo[]): Todo[] {
  return [...items].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'pending' ? -1 : 1
    if (a.status === 'pending' && b.status === 'pending') {
      return (new Date(a.dueDate ?? '9999-12-31').getTime() - new Date(b.dueDate ?? '9999-12-31').getTime()) || (b.priority - a.priority)
    }
    return new Date(b.completedAt ?? b.updatedAt).getTime() - new Date(a.completedAt ?? a.updatedAt).getTime()
  })
}

export default function TodosPage() {
  const { tags, categories, running, start } = useStore()
  const [todos, setTodos] = useState<Todo[]>([])
  const [activeTab, setActiveTab] = useState<'todo' | 'diary'>('todo')
  const [activityView, setActivityView] = useState<ActivityView>('current')
  const [filterCat, setFilterCat] = useState('')
  const [oneTimeCollapsed, setOneTimeCollapsed] = useState(false)
  const [showQuickAdd, setShowQuickAdd] = useState(false)
  const [quickTitle, setQuickTitle] = useState('')
  const [editing, setEditing] = useState<Todo | null>(null)
  const [pickingTagFor, setPickingTagFor] = useState<Todo | null>(null)
  const [error, setError] = useState('')
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set())
  const loadSequence = useRef(0)

  const load = async () => {
    // Always load all todos so we can split pending/done locally
    const sequence = ++loadSequence.current
    try {
      const all = await api.todos.list()
      if (sequence !== loadSequence.current) return
      setTodos(all)
      void syncActivityNotifications(all)
      setError('')
    } catch (e) {
      if (sequence !== loadSequence.current) return
      setError(e instanceof Error ? e.message : '加载待办失败')
    }
  }

  useEffect(() => { void load() }, [])

  const quickAdd = async () => {
    if (!quickTitle.trim()) return
    try {
      await api.todos.create({ title: quickTitle.trim() })
      setQuickTitle('')
      setShowQuickAdd(false)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : '新建待办失败')
    }
  }

  const toggle = async (id: string) => {
    if (togglingIds.has(id)) return
    const todo = todos.find((item) => item.id === id)
    let lateReason: string | undefined
    let restoreReason: string | undefined
    if (todo?.status === 'done') {
      const reason = window.prompt('请填写恢复未完成的原因')
      if (reason === null) return
      restoreReason = reason.trim()
      if (!restoreReason) {
        setError('恢复未完成必须填写原因')
        return
      }
    } else if (todo?.dueDate && new Date(todo.dueDate).getTime() < Date.now()) {
      const reason = window.prompt('这项活动已经超时，请填写原因')
      if (reason === null) return
      lateReason = reason.trim()
      if (!lateReason) {
        setError('超时完成必须填写原因')
        return
      }
    }
    setTogglingIds((current) => new Set(current).add(id))
    try {
      await api.todos.toggle(id, lateReason, restoreReason)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : '更新待办状态失败')
    } finally {
      setTogglingIds((current) => {
        const next = new Set(current)
        next.delete(id)
        return next
      })
    }
  }

  const remove = async (id: string) => {
    if (!confirm('确定删除这条待办吗？')) return
    try {
      await api.todos.remove(id)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除待办失败')
    }
  }

  const startFromTodo = async (todo: Todo, tagId: string) => {
    try {
      await start(tagId, todo.title, todo.id)
      setPickingTagFor(null)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : '开始计时失败')
    }
  }

  const categoryFiltered = useMemo(() => {
    if (!filterCat) return todos
    if (filterCat === 'none') return todos.filter((todo) => !todo.categoryId)
    return todos.filter((todo) => todo.categoryId === filterCat)
  }, [todos, filterCat])

  const cycleItems = (cycle: ActivityCycle) => sortActivityItems(categoryFiltered.filter((todo) => {
    if (todo.repeatType !== cycle) return false
    if (activityView === 'completed') return todo.status === 'done'
    if (activityView === 'current') return isInCurrentCycle(todo, cycle)
    return true
  }))

  const oneTimeItems = sortActivityItems(categoryFiltered.filter((todo) => {
    if (todo.repeatType !== 'none') return false
    if (activityView === 'completed') return todo.status === 'done'
    if (activityView === 'current') return todo.status === 'pending' || (todo.status === 'done' && todo.completedAt && isSameLocalDay(new Date(todo.completedAt), new Date()))
    return true
  }))
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-6 border-b border-gray-200 dark:border-gray-800" role="tablist" aria-label="待办与日记">
        {([
          ['todo', '待办'],
          ['diary', '日记'],
        ] as const).map(([tab, label]) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            onClick={() => setActiveTab(tab)}
            className={`relative -mb-px pb-3 text-lg font-semibold transition-colors ${
              activeTab === tab
                ? 'text-brand after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-brand'
                : 'text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {error && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300">
          <span>{error}</span>
          <button type="button" onClick={() => setError('')} className="text-xs hover:underline">关闭</button>
        </div>
      )}

      {activeTab === 'todo' ? (
        <section className="rounded-xl border border-gray-200 dark:border-gray-800 bg-gray-50/70 dark:bg-gray-900/40 p-4 sm:p-5">
            <div className="flex items-center gap-2 flex-wrap mt-4">
              <div className="flex items-center gap-1 overflow-x-auto pb-1">
                {([
                  ['current', '当前周期'],
                  ['all', '全部'],
                  ['completed', '已完成'],
                ] as const).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setActivityView(value)}
                    className={`px-3 py-1 rounded-full text-sm whitespace-nowrap transition-colors ${
                      activityView === value
                        ? 'bg-brand text-white'
                        : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <select
                value={filterCat}
                onChange={(event) => setFilterCat(event.target.value)}
                className="text-sm border border-gray-200 dark:border-gray-800 rounded-full px-3 py-1 bg-white dark:bg-gray-900 text-gray-500"
              >
                <option value="">全部分类</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>{category.name}</option>
                ))}
                <option value="none">未分类</option>
              </select>
              <button type="button" onClick={() => setShowQuickAdd(!showQuickAdd)} className="ml-auto text-sm text-brand hover:underline whitespace-nowrap">
                {showQuickAdd ? '取消' : '+ 新建一次性活动'}
              </button>
            </div>

            {showQuickAdd && (
              <div className="rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 p-3 flex gap-2 mt-3">
                <input
                  value={quickTitle}
                  onChange={(event) => setQuickTitle(event.target.value)}
                  onKeyDown={(event) => event.key === 'Enter' && quickAdd()}
                  placeholder="活动内容，回车添加…"
                  className="input"
                  autoFocus
                />
                <button type="button" onClick={quickAdd} className="px-4 py-2 rounded-lg text-sm bg-brand text-white hover:bg-brand-600 whitespace-nowrap">
                  添加
                </button>
              </div>
            )}

            <section className="mt-4 rounded-xl border border-amber-200/80 bg-amber-50/60 dark:border-amber-900/60 dark:bg-amber-950/20 p-3">
              <div className="flex items-center justify-between gap-2 mb-2">
                <div>
                  <h2 className="font-semibold text-amber-800 dark:text-amber-200">一次性活动</h2>
                  <p className="text-xs text-amber-700/70 dark:text-amber-300/70">优先处理，不属于日、周、月循环</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-amber-700/70 dark:text-amber-300/70">{oneTimeItems.length} 项</span>
                  <button
                    type="button"
                    aria-expanded={!oneTimeCollapsed}
                    aria-controls="one-time-activities"
                    aria-label={oneTimeCollapsed ? '展开一次性活动' : '折叠一次性活动'}
                    title={oneTimeCollapsed ? '展开一次性活动' : '折叠一次性活动'}
                    onClick={() => setOneTimeCollapsed((collapsed) => !collapsed)}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-amber-700/80 transition-colors hover:bg-amber-100 dark:text-amber-300/80 dark:hover:bg-amber-900/40"
                  >
                    <span aria-hidden="true" className={`text-base leading-none transition-transform ${oneTimeCollapsed ? '-rotate-90' : ''}`}>⌄</span>
                  </button>
                </div>
              </div>
              <div id="one-time-activities" hidden={oneTimeCollapsed} className="space-y-2">
                {oneTimeItems.length === 0 ? (
                  <div className="py-3 text-center text-sm text-gray-400">暂无一次性活动</div>
                ) : oneTimeItems.map((todo) => (
                  <TodoCard
                    key={todo.id}
                    todo={todo}
                    running={running}
                    busy={togglingIds.has(todo.id)}
                    onToggle={toggle}
                    onEdit={setEditing}
                    onDelete={remove}
                    onPickTag={setPickingTagFor}
                    isDone={todo.status === 'done'}
                  />
                ))}
              </div>
            </section>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3 items-stretch">
              <ActivityModule title="日活动" subtitle="当前自然日" items={cycleItems('daily')} emptyText="今天暂无日活动" running={running} togglingIds={togglingIds} onToggle={toggle} onEdit={setEditing} onDelete={remove} onPickTag={setPickingTagFor} />
              <ActivityModule title="周活动" subtitle="当前自然周" items={cycleItems('weekly')} emptyText="本周暂无周活动" running={running} togglingIds={togglingIds} onToggle={toggle} onEdit={setEditing} onDelete={remove} onPickTag={setPickingTagFor} />
              <ActivityModule title="月活动" subtitle="当前自然月" items={cycleItems('monthly')} emptyText="本月暂无月活动" running={running} togglingIds={togglingIds} onToggle={toggle} onEdit={setEditing} onDelete={remove} onPickTag={setPickingTagFor} />
            </div>
        </section>
      ) : (
        <section className="rounded-xl border border-gray-200 dark:border-gray-800 bg-gray-50/70 dark:bg-gray-900/40 p-4 sm:p-5">
          <DiaryPanel />
        </section>
      )}

      {/* Edit modal */}
      {editing && (
        <TodoEditModal
          todo={editing}
          categories={categories}
          tags={tags}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load() }}
        />
      )}

      {/* Tag picker modal */}
      {pickingTagFor && (
        <TagPickerModal
          todo={pickingTagFor}
          tags={tags.filter((t) => t.categoryId === pickingTagFor.categoryId && !t.parentId)}
          onClose={() => setPickingTagFor(null)}
          onPick={(tagId) => startFromTodo(pickingTagFor, tagId)}
        />
      )}
    </div>
  )
}

function ActivityModule({
  title,
  subtitle,
  items,
  emptyText,
  running,
  togglingIds,
  onToggle,
  onEdit,
  onDelete,
  onPickTag,
}: {
  title: string
  subtitle: string
  items: Todo[]
  emptyText: string
  running: any[]
  togglingIds: Set<string>
  onToggle: (id: string) => void
  onEdit: (todo: Todo) => void
  onDelete: (id: string) => void
  onPickTag: (todo: Todo) => void
}) {
  return (
    <section className="min-h-[190px] max-h-[calc(100vh-18rem)] overflow-y-auto rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-3">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div>
          <h2 className="font-semibold text-gray-800 dark:text-gray-100">{title}</h2>
          <p className="text-xs text-gray-400">{subtitle}</p>
        </div>
        <span className="text-xs text-gray-400">{items.length} 项</span>
      </div>
      <div className="space-y-2">
        {items.length === 0 ? (
          <div className="py-6 text-center text-sm text-gray-400">{emptyText}</div>
        ) : items.map((todo) => (
          <TodoCard
            key={todo.id}
            todo={todo}
            running={running}
            busy={togglingIds.has(todo.id)}
            onToggle={onToggle}
            onEdit={onEdit}
            onDelete={onDelete}
            onPickTag={onPickTag}
            isDone={todo.status === 'done'}
          />
        ))}
      </div>
    </section>
  )
}

// ── Todo Card ─────────────────────────────────────────────────────────────
function TodoCard({
  todo,
  running,
  busy = false,
  onToggle,
  onEdit,
  onDelete,
  onPickTag,
  isDone = false,
}: {
  todo: Todo
  running: any[]
  busy?: boolean
  onToggle: (id: string) => void
  onEdit: (t: Todo) => void
  onDelete: (id: string) => void
  onPickTag: (t: Todo) => void
  isDone?: boolean
}) {
  return (
    <div
      className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors ${
        isDone ? 'bg-green-50/70 border-green-200 dark:bg-green-950/20 dark:border-green-900/60' : 'bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-800'
      }`}
    >
      <button
        type="button"
        disabled={busy}
        aria-label={isDone ? `恢复未完成：${todo.title}` : `完成活动：${todo.title}`}
        onClick={() => onToggle(todo.id)}
        className="mt-0.5 -ml-2 -mt-2 w-9 h-9 rounded-full flex-shrink-0 flex items-center justify-center hover:bg-gray-100 dark:hover:bg-gray-800 active:bg-gray-200 dark:active:bg-gray-700 disabled:opacity-60"
      >
        <span className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${
          isDone ? 'border-green-500 bg-green-500 text-white' : 'border-gray-300 dark:border-gray-600 hover:border-brand'
        }`}>
          {isDone && <span className="text-[10px]">✓</span>}
        </span>
      </button>
      <div className="flex-1 min-w-0">
        <div className={`text-sm font-medium ${todo.status === 'done' ? 'line-through text-gray-400' : ''}`}>
          {todo.priority === 2 && <span className="text-red-500 mr-1">🔴</span>}
          {todo.priority === 1 && <span className="text-amber-500 mr-1">🟡</span>}
          {todo.title}
        </div>
        {todo.description && (
          <div className="text-xs text-gray-400 mt-0.5">{todo.description}</div>
        )}
        {todo.lateReason && (
          <div className="text-xs text-orange-600/90 dark:text-orange-300/90 mt-0.5">超时原因：{todo.lateReason}</div>
        )}
        {todo.restoreReason && (
          <div className="text-xs text-amber-600/80 dark:text-amber-300/80 mt-0.5">恢复原因：{todo.restoreReason}</div>
        )}
        <div className="flex items-center gap-2 mt-1 flex-wrap">
          {todo.category && (
            <span
              className="text-xs px-2 py-0.5 rounded-full"
              style={{ background: todo.category.color + '22', color: todo.category.color }}
            >
              {todo.category.name}
            </span>
          )}
          {todo.tag && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-300">
              {todo.tag.name}
            </span>
          )}
          {todo.repeatType !== 'none' && (
            <span className="text-xs text-brand-500">
              {todo.repeatType === 'daily' ? '每日' : todo.repeatType === 'weekly' ? '每周' : '每月'}
            </span>
          )}
          {todo._count && todo._count.timeEntries > 0 && (
            <span className="text-xs text-gray-400">已记录 {todo._count.timeEntries} 次</span>
          )}
          {todo.dueDate && (
            <span className="text-xs text-gray-400">
              📅 {todo.goalId ? `截止 ${formatActivityDueDate(todo.dueDate)}` : new Date(todo.dueDate).toLocaleDateString('zh-CN')}
            </span>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-1 items-end flex-shrink-0">
        {todo.status === 'pending' && todo.categoryId && (
          running.some((r) => r.todoId === todo.id) ? (
            <span className="text-xs text-green-500">● 计时中</span>
          ) : (
            <button onClick={() => onPickTag(todo)} className="text-xs text-brand hover:underline">
              ▶ 计时
            </button>
          )
        )}
        <button onClick={() => onEdit(todo)} className="text-xs text-gray-400 hover:text-brand">
          编辑
        </button>
        <button onClick={() => onDelete(todo.id)} className="text-xs text-gray-300 hover:text-red-500">
          ✕
        </button>
      </div>
    </div>
  )
}

// ── Edit Modal ────────────────────────────────────────────────────────────
function TodoEditModal({ todo, categories, tags, onClose, onSaved }: {
  todo: Todo
  categories: { id: string; name: string; color: string }[]
  tags: { id: string; name: string; categoryId: string | null }[]
  onClose: () => void
  onSaved: () => void
}) {
  const [title, setTitle] = useState(todo.title)
  const [description, setDescription] = useState(todo.description ?? '')
  const [priority, setPriority] = useState(todo.priority)
  const [categoryId, setCategoryId] = useState(todo.categoryId ?? '')
  const [tagId, setTagId] = useState(todo.tagId ?? '')
  const [repeatType, setRepeatType] = useState(todo.repeatType ?? 'none')
  const [dueDate, setDueDate] = useState(
    todo.dueDate ? new Date(todo.dueDate).toISOString().slice(0, 10) : ''
  )
  const [status, setStatus] = useState(todo.status)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const save = async () => {
    if (!title.trim() || saving) {
      if (!title.trim()) setError('标题不能为空')
      return
    }
    setSaving(true)
    setError('')
    try {
      await api.todos.update(todo.id, {
        title: title.trim(),
        description: description.trim() || null,
        priority,
        categoryId: categoryId || null,
        tagId: tagId || null,
        ...(todo.goalId ? {} : {
          repeatType,
          dueDate: dueDate ? new Date(dueDate).toISOString() : null,
        }),
        status,
      })
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存待办失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 rounded-2xl p-6 w-full max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold mb-4">编辑待办</h3>
        <div className="space-y-4">
          <div>
            <label className="block text-sm text-gray-500 mb-1">标题</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} className="input" autoFocus />
          </div>
          <div>
            <label className="block text-sm text-gray-500 mb-1">描述（可选）</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className="input" />
          </div>
          <div className="flex gap-4">
            <div className="flex-1">
              <label className="block text-sm text-gray-500 mb-1">优先级</label>
              <div className="flex gap-2">
                {PRIORITY.map((p) => (
                  <button
                    key={p.value}
                    onClick={() => setPriority(p.value)}
                    className={`px-3 py-1 rounded-full text-xs border ${
                      priority === p.value
                        ? `${p.color} border-current font-medium`
                        : 'text-gray-400 border-gray-300 dark:border-gray-700'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex-1">
              <label className="block text-sm text-gray-500 mb-1">状态</label>
              {todo.status === 'done' ? (
                <div className="text-sm text-green-600 dark:text-green-400">已完成（点击复选框可恢复，并填写原因）</div>
              ) : (
                <div className="flex gap-2">
                  <button
                    onClick={() => setStatus('pending')}
                    className={`px-3 py-1 rounded-full text-xs border ${
                      status === 'pending' ? 'text-brand border-current font-medium' : 'text-gray-400 border-gray-300 dark:border-gray-700'
                    }`}
                  >
                    待完成
                  </button>
                  <button
                    onClick={() => setStatus('done')}
                    className={`px-3 py-1 rounded-full text-xs border ${
                      status === 'done' ? 'text-green-500 border-current font-medium' : 'text-gray-400 border-gray-300 dark:border-gray-700'
                    }`}
                  >
                    已完成
                  </button>
                </div>
              )}
            </div>
          </div>
          <div className="flex gap-4">
            <div className="flex-1">
              <label className="block text-sm text-gray-500 mb-1">关联分类</label>
              <select value={categoryId} onChange={(e) => { setCategoryId(e.target.value); setTagId('') }} className="input">
                <option value="">无分类</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <label className="block text-sm text-gray-500 mb-1">活动标签</label>
              <select value={tagId} onChange={(e) => setTagId(e.target.value)} className="input" disabled={!categoryId}>
                <option value="">无活动标签</option>
                {tags.filter((tag) => tag.categoryId === categoryId).map((tag) => (
                  <option key={tag.id} value={tag.id}>{tag.name}</option>
                ))}
              </select>
            </div>
          </div>
          {todo.goalId ? (
            <div className="rounded-lg bg-gray-50 dark:bg-gray-800/60 px-3 py-2 text-xs text-gray-500">
              活动周期和截止时间由对应目标管理：{todo.dueDate ? formatActivityDueDate(todo.dueDate) : '未设置'}
            </div>
          ) : (
            <div className="flex gap-4">
              <div className="flex-1">
                <label className="block text-sm text-gray-500 mb-1">循环</label>
                <select value={repeatType} onChange={(e) => setRepeatType(e.target.value as Todo['repeatType'])} className="input">
                  <option value="none">不循环</option>
                  <option value="daily">每日</option>
                  <option value="weekly">每周</option>
                  <option value="monthly">每月</option>
                </select>
              </div>
              <div className="flex-1">
                <label className="block text-sm text-gray-500 mb-1">截止日期</label>
                <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="input" />
              </div>
            </div>
          )}
        </div>
        {error && <div className="mt-4 text-sm text-red-500">{error}</div>}
        <div className="flex justify-end gap-2 mt-6">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800">
            取消
          </button>
          <button onClick={save} disabled={saving} className="px-4 py-2 rounded-lg text-sm bg-brand text-white hover:bg-brand-600 disabled:opacity-50">
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}

function formatActivityDueDate(value: string): string {
  return new Date(value).toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// ── Tag Picker Modal ──────────────────────────────────────────────────────
function TagPickerModal({ todo, tags, onClose, onPick }: {
  todo: Todo
  tags: { id: string; name: string; color: string }[]
  onClose: () => void
  onPick: (tagId: string) => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 rounded-2xl p-6 w-full max-w-sm mx-4" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold mb-1">选择标签开始计时</h3>
        <p className="text-sm text-gray-400 mb-4">{todo.title}</p>
        {tags.length === 0 ? (
          <div className="text-center py-6 text-gray-400 text-sm">
            该分类下暂无标签，请先在标签管理中添加
          </div>
        ) : (
          <div className="space-y-2">
            {tags.map((t) => (
              <button
                key={t.id}
                onClick={() => onPick(t.id)}
                className="w-full flex items-center gap-3 px-4 py-3 rounded-lg border border-gray-200 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800 transition"
              >
                <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: t.color }} />
                <span className="text-sm font-medium">{t.name}</span>
                <span className="ml-auto text-xs text-gray-400">▶ 开始</span>
              </button>
            ))}
          </div>
        )}
        <div className="flex justify-end mt-4">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800">
            取消
          </button>
        </div>
      </div>
    </div>
  )
}
