import { useEffect, useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import type { Todo } from '../types'

const PRIORITY = [
  { value: 0, label: '普通', color: 'text-gray-400' },
  { value: 1, label: '重要', color: 'text-amber-500' },
  { value: 2, label: '紧急', color: 'text-red-500' },
]

export default function TodosPage() {
  const { tags, categories, running, start } = useStore()
  const [todos, setTodos] = useState<Todo[]>([])
  const [filter, setFilter] = useState<'all' | 'pending' | 'done'>('pending')
  const [filterCat, setFilterCat] = useState('')
  const [showQuickAdd, setShowQuickAdd] = useState(false)
  const [quickTitle, setQuickTitle] = useState('')
  const [editing, setEditing] = useState<Todo | null>(null)
  const [pickingTagFor, setPickingTagFor] = useState<Todo | null>(null)

  const load = async () => {
    const status = filter === 'all' ? undefined : filter
    setTodos(await api.todos.list({ status }))
  }

  useEffect(() => { load() }, [filter])

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

  // 从 todo 发起计时：先选择该分类下的具体标签
  const startFromTodo = async (todo: Todo, tagId: string) => {
    await start(tagId, todo.title, todo.id)
    setPickingTagFor(null)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">待办</h1>
        <button onClick={() => setShowQuickAdd(!showQuickAdd)} className="text-sm text-brand hover:underline">
          {showQuickAdd ? '取消' : '+ 新建'}
        </button>
      </div>

      {/* 快速添加（仅标题，详细属性用编辑弹窗） */}
      {showQuickAdd && (
        <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 p-4 flex gap-2">
          <input
            value={quickTitle}
            onChange={(e) => setQuickTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && quickAdd()}
            placeholder="待办内容，回车添加…"
            className="input"
            autoFocus
          />
          <button onClick={quickAdd} className="px-4 py-2 rounded-lg text-sm bg-brand text-white hover:bg-brand-600 whitespace-nowrap">
            添加
          </button>
        </div>
      )}

      {/* 筛选 */}
      <div className="flex items-center gap-2 flex-wrap">
        {(['pending', 'all', 'done'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1 rounded-full text-sm ${filter === f ? 'bg-brand-100 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300' : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'}`}
          >
            {f === 'pending' ? '待完成' : f === 'done' ? '已完成' : '全部'}
          </button>
        ))}
        <select
          value={filterCat}
          onChange={(e) => setFilterCat(e.target.value)}
          className="text-sm border border-gray-200 dark:border-gray-800 rounded-full px-3 py-1 bg-white dark:bg-gray-900 text-gray-500"
        >
          <option value="">全部分类</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
          <option value="none">未分类</option>
        </select>
      </div>

      {/* 列表 */}
      <div className="space-y-2">
        {(() => {
          const filtered = todos.filter((t) =>
            !filterCat ||
            (filterCat === 'none' ? !t.categoryId : t.categoryId === filterCat)
          )
          if (filtered.length === 0) {
            return <div className="text-center py-10 text-gray-400">暂无待办</div>
          }
          return filtered.map((todo) => (
          <div
            key={todo.id}
            className={`flex items-start gap-3 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 px-4 py-3 ${todo.status === 'done' ? 'opacity-50' : ''}`}
          >
            <button
              onClick={() => toggle(todo.id)}
              className={`mt-0.5 w-5 h-5 rounded-full border-2 flex-shrink-0 flex items-center justify-center ${todo.status === 'done' ? 'bg-brand border-brand text-white' : 'border-gray-300 dark:border-gray-600'}`}
            >
              {todo.status === 'done' && '✓'}
            </button>
            <div className="flex-1 min-w-0">
              <div className={`text-sm font-medium ${todo.status === 'done' ? 'line-through' : ''}`}>
                {todo.priority === 2 && <span className="text-red-500 mr-1">🔴</span>}
                {todo.priority === 1 && <span className="text-amber-500 mr-1">🟡</span>}
                {todo.title}
              </div>
              {todo.description && (
                <div className="text-xs text-gray-400 mt-0.5">{todo.description}</div>
              )}
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                {todo.category && (
                  <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: todo.category.color + '22', color: todo.category.color }}>
                    {todo.category.name}
                  </span>
                )}
                {todo._count && todo._count.timeEntries > 0 && (
                  <span className="text-xs text-gray-400">已记录 {todo._count.timeEntries} 次</span>
                )}
                {todo.dueDate && (
                  <span className="text-xs text-gray-400">📅 {new Date(todo.dueDate).toLocaleDateString('zh-CN')}</span>
                )}
              </div>
            </div>
            <div className="flex flex-col gap-1 items-end">
              {todo.status === 'pending' && todo.categoryId && (
                running.some((r) => r.todoId === todo.id) ? (
                  <span className="text-xs text-green-500">● 计时中</span>
                ) : (
                  <button
                    onClick={() => setPickingTagFor(todo)}
                    className="text-xs text-brand hover:underline"
                  >
                    ▶ 计时
                  </button>
                )
              )}
              <button
                onClick={() => setEditing(todo)}
                className="text-xs text-gray-400 hover:text-brand"
              >
                编辑
              </button>
              <button onClick={() => remove(todo.id)} className="text-xs text-gray-300 hover:text-red-500">
                ✕
              </button>
            </div>
          </div>
        ))
        })()}
      </div>

      {/* 编辑弹窗 */}
      {editing && (
        <TodoEditModal
          todo={editing}
          categories={categories}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load() }}
        />
      )}

      {/* 标签选择器：从待办发起计时时，选择该分类下的具体标签 */}
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
                    className={`px-3 py-1 rounded-full text-xs border ${priority === p.value ? `${p.color} border-current font-medium` : 'text-gray-400 border-gray-300 dark:border-gray-700'}`}
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
                  className={`px-3 py-1 rounded-full text-xs border ${status === 'pending' ? 'text-brand border-current font-medium' : 'text-gray-400 border-gray-300 dark:border-gray-700'}`}
                >
                  待完成
                </button>
                <button
                  onClick={() => setStatus('done')}
                  className={`px-3 py-1 rounded-full text-xs border ${status === 'done' ? 'text-green-500 border-current font-medium' : 'text-gray-400 border-gray-300 dark:border-gray-700'}`}
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

// 标签选择器：从待办发起计时时，选择该分类下的具体标签
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
