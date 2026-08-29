import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import type { Todo } from '../types'
import DiaryPanel from '../components/DiaryPanel'

const PRIORITY = [
  { value: 0, label: '普通', color: 'text-gray-400' },
  { value: 1, label: '重要', color: 'text-amber-500' },
  { value: 2, label: '紧急', color: 'text-red-500' },
]

type DaysRange = 1 | 7 | 30

function formatDate(d: Date) {
  return d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' })
}

function isWithinDays(dateStr: string, days: DaysRange): boolean {
  const date = new Date(dateStr)
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)
  return date >= cutoff
}

function groupByDay(todos: Todo[]): { dateLabel: string; items: Todo[] }[] {
  const map = new Map<string, Todo[]>()
  for (const t of todos) {
    const d = new Date(t.updatedAt || t.createdAt)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(t)
  }
  return Array.from(map.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([key, items]) => ({
      dateLabel: formatDate(new Date(key + 'T12:00:00')),
      items,
    }))
}

export default function TodosPage() {
  const { tags, categories, running, start } = useStore()
  const [todos, setTodos] = useState<Todo[]>([])
  const [activePane, setActivePane] = useState<'balanced' | 'todos' | 'diary'>('balanced')
  const [desktopPointer, setDesktopPointer] = useState(false)
  const [filter, setFilter] = useState<'all' | 'pending' | 'done'>('pending')
  const [filterCat, setFilterCat] = useState('')
  const [daysRange, setDaysRange] = useState<DaysRange>(30)
  const [showQuickAdd, setShowQuickAdd] = useState(false)
  const [quickTitle, setQuickTitle] = useState('')
  const [editing, setEditing] = useState<Todo | null>(null)
  const [pickingTagFor, setPickingTagFor] = useState<Todo | null>(null)

  const load = async () => {
    // Always load all todos so we can split pending/done locally
    const all = await api.todos.list()
    setTodos(all)
  }

  useEffect(() => { load() }, [])

  const quickAdd = async () => {
    if (!quickTitle.trim()) return
    await api.todos.create({ title: quickTitle })
    setQuickTitle('')
    setShowQuickAdd(false)
    load()
  }

  const toggle = async (id: string) => {
    await api.todos.toggle(id)
    load()
  }

  const remove = async (id: string) => {
    await api.todos.remove(id)
    load()
  }

  const startFromTodo = async (todo: Todo, tagId: string) => {
    await start(tagId, todo.title, todo.id)
    setPickingTagFor(null)
  }

  useEffect(() => {
    const media = window.matchMedia('(hover: hover) and (pointer: fine)')
    const updatePointerMode = () => setDesktopPointer(media.matches)
    updatePointerMode()
    media.addEventListener?.('change', updatePointerMode)
    return () => media.removeEventListener?.('change', updatePointerMode)
  }, [])

  const handlePaneMouseEnter = (pane: 'todos' | 'diary') => {
    if (desktopPointer) setActivePane((current) => current === pane ? current : pane)
  }

  const handleWorkspaceMouseLeave = () => {
    if (desktopPointer) setActivePane('balanced')
  }

  // ── Category filter: match todo.categoryId ──────────────────────────────
  const catFiltered = useMemo(() => {
    if (!filterCat) return todos
    if (filterCat === 'none') return todos.filter((t) => !t.categoryId)
    return todos.filter((t) => t.categoryId === filterCat)
  }, [todos, filterCat])

  // ── Split pending vs done ───────────────────────────────────────────────
  const pendingTodos = useMemo(
    () => catFiltered.filter((t) => t.status === 'pending').sort((a, b) => b.priority - a.priority),
    [catFiltered],
  )
  const doneTodos = useMemo(
    () =>
      catFiltered
        .filter((t) => t.status === 'done')
        .filter((t) => {
          const dateField = t.updatedAt ?? t.dueDate ?? t.createdAt
          if (!dateField) return filter === 'all' // always show if no date and in all
          return isWithinDays(dateField, daysRange)
        })
        .sort((a, b) => {
          const da = new Date(a.updatedAt ?? a.createdAt).getTime()
          const db = new Date(b.updatedAt ?? b.createdAt).getTime()
          return db - da
        }),
    [catFiltered, daysRange, filter],
  )

  const doneGroups = useMemo(() => groupByDay(doneTodos), [doneTodos])

  // What to show based on filter
  const showPending = filter === 'pending' || filter === 'all'
  const showDone = filter === 'done' || filter === 'all'
  const todosActive = activePane === 'todos'
  const diaryActive = activePane === 'diary'

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">待办与日记</h1>
      </div>

      <div
        className="todo-diary-workspace"
        onMouseLeave={handleWorkspaceMouseLeave}
      >
        <section
          className={`todo-diary-pane ${todosActive ? 'todo-diary-pane--active' : diaryActive ? 'todo-diary-pane--compact' : ''}`}
          onMouseEnter={() => handlePaneMouseEnter('todos')}
          onClick={() => setActivePane('todos')}
          data-pane="todos"
          aria-label="待办面板"
        >
          <div className="todo-diary-pane__scale p-4 sm:p-5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-xl font-bold">待办</h2>
              <button onClick={() => setShowQuickAdd(!showQuickAdd)} className="text-sm text-brand hover:underline whitespace-nowrap">
                {showQuickAdd ? '取消' : '+ 新建'}
              </button>
            </div>

            {showQuickAdd && (
              <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 p-4 flex gap-2 mt-4">
                <input
                  value={quickTitle}
                  onChange={(event) => setQuickTitle(event.target.value)}
                  onKeyDown={(event) => event.key === 'Enter' && quickAdd()}
                  placeholder="待办内容，回车添加…"
                  className="input"
                  autoFocus
                />
                <button onClick={quickAdd} className="px-4 py-2 rounded-lg text-sm bg-brand text-white hover:bg-brand-600 whitespace-nowrap">
                  添加
                </button>
              </div>
            )}

            <div className="flex items-center gap-2 flex-wrap mt-4">
              {(['pending', 'all', 'done'] as const).map((item) => (
                <button
                  key={item}
                  onClick={() => setFilter(item)}
                  className={`px-3 py-1 rounded-full text-sm transition-colors ${
                    filter === item
                      ? 'bg-brand-100 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300'
                      : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
                  }`}
                >
                  {item === 'pending' ? '待完成' : item === 'done' ? '已完成' : '全部'}
                </button>
              ))}

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

              {(filter === 'done' || filter === 'all') && (
                <div className="flex items-center gap-1 ml-auto">
                  <span className="text-xs text-gray-400">已完成：</span>
                  {([1, 7, 30] as DaysRange[]).map((range) => (
                    <button
                      key={range}
                      onClick={() => setDaysRange(range)}
                      className={`px-2 py-0.5 rounded-full text-xs transition-colors ${
                        daysRange === range
                          ? 'bg-brand text-white'
                          : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
                      }`}
                    >
                      {range}天
                    </button>
                  ))}
                </div>
              )}
            </div>

            {showPending && (
              <div className="space-y-2 mt-4">
                {pendingTodos.length === 0 && filter === 'pending' && (
                  <div className="text-center py-10 text-gray-400">暂无待办 🎉</div>
                )}
                {pendingTodos.map((todo) => (
                  <TodoCard
                    key={todo.id}
                    todo={todo}
                    running={running}
                    onToggle={toggle}
                    onEdit={setEditing}
                    onDelete={remove}
                    onPickTag={setPickingTagFor}
                  />
                ))}
              </div>
            )}

            {showDone && (
              <div className="mt-4">
                {doneGroups.length === 0 ? (
                  <div className="text-center py-10 text-gray-400">
                    {daysRange}天内暂无已完成待办
                  </div>
                ) : (
                  <div className="space-y-6">
                    {filter === 'all' && pendingTodos.length > 0 && (
                      <div className="flex items-center gap-2 pt-2">
                        <div className="flex-1 h-px bg-gray-200 dark:bg-gray-800" />
                        <span className="text-xs text-gray-400 px-2">已完成时间轴（近{daysRange}天）</span>
                        <div className="flex-1 h-px bg-gray-200 dark:bg-gray-800" />
                      </div>
                    )}
                    {doneGroups.map(({ dateLabel, items }) => (
                      <div key={dateLabel} className="relative pl-6">
                        <div className="absolute left-2 top-4 bottom-0 w-px bg-gray-200 dark:bg-gray-700" />
                        <div className="flex items-center gap-2 mb-3">
                          <div className="absolute left-0 w-4 h-4 rounded-full bg-brand flex items-center justify-center">
                            <div className="w-1.5 h-1.5 rounded-full bg-white" />
                          </div>
                          <span className="text-xs font-semibold text-brand-600 dark:text-brand-400 ml-1">{dateLabel}</span>
                          <span className="text-xs text-gray-400">（{items.length}项）</span>
                        </div>
                        <div className="space-y-2">
                          {items.map((todo) => (
                            <TodoCard
                              key={todo.id}
                              todo={todo}
                              running={running}
                              onToggle={toggle}
                              onEdit={setEditing}
                              onDelete={remove}
                              onPickTag={setPickingTagFor}
                              isDone
                            />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

        <section
          className={`todo-diary-pane ${diaryActive ? 'todo-diary-pane--active' : todosActive ? 'todo-diary-pane--compact' : ''}`}
          onMouseEnter={() => handlePaneMouseEnter('diary')}
          onClick={() => setActivePane('diary')}
          data-pane="diary"
          aria-label="日记面板"
        >
          <DiaryPanel compact={todosActive} />
        </section>
      </div>

      {/* Edit modal */}
      {editing && (
        <TodoEditModal
          todo={editing}
          categories={categories}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load() }}
        />
      )}

      {/* Tag picker modal */}
      {pickingTagFor && (
        <TagPickerModal
          todo={pickingTagFor}
          tags={tags.filter((t) => t.categoryId === pickingTagFor.categoryId)}
          onClose={() => setPickingTagFor(null)}
          onPick={(tagId) => startFromTodo(pickingTagFor, tagId)}
        />
      )}
    </div>
  )
}

// ── Todo Card ─────────────────────────────────────────────────────────────
function TodoCard({
  todo,
  running,
  onToggle,
  onEdit,
  onDelete,
  onPickTag,
  isDone = false,
}: {
  todo: Todo
  running: any[]
  onToggle: (id: string) => void
  onEdit: (t: Todo) => void
  onDelete: (id: string) => void
  onPickTag: (t: Todo) => void
  isDone?: boolean
}) {
  return (
    <div
      className={`flex items-start gap-3 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 px-4 py-3 transition-opacity ${
        isDone ? 'opacity-60' : ''
      }`}
    >
      <button
        onClick={() => onToggle(todo.id)}
        className={`mt-0.5 w-5 h-5 rounded-full border-2 flex-shrink-0 flex items-center justify-center ${
          todo.status === 'done'
            ? 'bg-brand border-brand text-white'
            : 'border-gray-300 dark:border-gray-600 hover:border-brand'
        }`}
      >
        {todo.status === 'done' && <span className="text-[10px]">✓</span>}
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
        <div className="flex items-center gap-2 mt-1 flex-wrap">
          {todo.category && (
            <span
              className="text-xs px-2 py-0.5 rounded-full"
              style={{ background: todo.category.color + '22', color: todo.category.color }}
            >
              {todo.category.name}
            </span>
          )}
          {todo._count && todo._count.timeEntries > 0 && (
            <span className="text-xs text-gray-400">已记录 {todo._count.timeEntries} 次</span>
          )}
          {todo.dueDate && (
            <span className="text-xs text-gray-400">
              📅 {new Date(todo.dueDate).toLocaleDateString('zh-CN')}
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
function TodoEditModal({ todo, categories, onClose, onSaved }: {
  todo: Todo
  categories: { id: string; name: string; color: string }[]
  onClose: () => void
  onSaved: () => void
}) {
  const [title, setTitle] = useState(todo.title)
  const [description, setDescription] = useState(todo.description ?? '')
  const [priority, setPriority] = useState(todo.priority)
  const [categoryId, setCategoryId] = useState(todo.categoryId ?? '')
  const [dueDate, setDueDate] = useState(
    todo.dueDate ? new Date(todo.dueDate).toISOString().slice(0, 10) : ''
  )
  const [status, setStatus] = useState(todo.status)

  const save = async () => {
    if (!title.trim()) return
    await api.todos.update(todo.id, {
      title,
      description: description || null,
      priority,
      categoryId: categoryId || null,
      dueDate: dueDate ? new Date(dueDate).toISOString() : null,
      status,
    })
    onSaved()
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
            </div>
          </div>
          <div className="flex gap-4">
            <div className="flex-1">
              <label className="block text-sm text-gray-500 mb-1">关联分类</label>
              <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="input">
                <option value="">无分类</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <label className="block text-sm text-gray-500 mb-1">截止日期</label>
              <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="input" />
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-6">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800">
            取消
          </button>
          <button onClick={save} className="px-4 py-2 rounded-lg text-sm bg-brand text-white hover:bg-brand-600">
            保存
          </button>
        </div>
      </div>
    </div>
  )
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
