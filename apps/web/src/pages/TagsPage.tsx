import { useState, useEffect } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import type { Category, Tag, Goal } from '../types'

const COLORS = ['#6d5efc', '#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#ec4899', '#8b5cf6', '#14b8a6', '#64748b']

export default function TagsPage() {
  const { categories, tags, loadAll } = useStore()
  const [showCatForm, setShowCatForm] = useState(false)
  const [showTagForm, setShowTagForm] = useState(false)
  const [editingCat, setEditingCat] = useState<Category | null>(null)
  const [editingTag, setEditingTag] = useState<Tag | null>(null)
  const [goals, setGoals] = useState<Goal[]>([])
  const [editingGoal, setEditingGoal] = useState<{ goal: Goal | null; tag: Tag } | null>(null)

  const loadGoals = async () => {
    try { setGoals(await api.goals.list()) } catch {}
  }
  useEffect(() => { loadGoals() }, [tags])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">标签与分类</h1>
      </div>

      {/* 分类管理 */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">分类</h2>
          <button
            onClick={() => { setEditingCat(null); setShowCatForm(true) }}
            className="text-sm text-brand hover:underline"
          >
            + 新建分类
          </button>
        </div>
        <div className="space-y-2">
          {categories.length === 0 && (
            <div className="text-sm text-gray-400 py-2">还没有分类，创建一个（如：日常、工作、宝宝）</div>
          )}
          {categories.map((cat) => (
            <div
              key={cat.id}
              className="flex items-center justify-between rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 px-4 py-2.5"
            >
              <div className="flex items-center gap-3">
                <span className="w-3 h-3 rounded-full" style={{ background: cat.color }} />
                <span className="font-medium">{cat.name}</span>
                <span className="text-xs text-gray-400">{cat._count?.tags ?? 0} 个标签</span>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => { setEditingCat(cat); setShowCatForm(true) }}
                  className="text-sm text-gray-400 hover:text-brand"
                >
                  编辑
                </button>
                <button
                  onClick={async () => {
                    if (!confirm(`删除分类「${cat.name}」？标签不会被删除，只是变为未分类。`)) return
                    await api.categories.remove(cat.id)
                    loadAll()
                  }}
                  className="text-sm text-gray-400 hover:text-red-500"
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 标签管理 */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">标签</h2>
          <button
            onClick={() => { setEditingTag(null); setShowTagForm(true) }}
            className="text-sm text-brand hover:underline"
          >
            + 新建标签
          </button>
        </div>
        <div className="space-y-2">
          {tags.map((tag) => (
            <div
              key={tag.id}
              className="flex items-center justify-between rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 px-4 py-2.5"
            >
              <div className="flex items-center gap-3">
                <span className="w-3 h-3 rounded-full" style={{ background: tag.color }} />
                <span className="font-medium">
                  {tag.icon ? `${tag.icon} ` : ''}{tag.name}
                </span>
                <span className="text-xs px-2 py-0.5 rounded-full"
                  style={{ background: tag.category?.color ?? '#e5e7eb', color: tag.category ? '#fff' : '#6b7280' }}
                >
                  {tag.category?.name ?? '未分类'}
                </span>
                {tag.trackType === 'count' && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400">
                    次数
                  </span>
                )}
              </div>
              <div className="flex gap-2">
                {goals.filter((g) => g.tagId === tag.id).length === 0 && (
                  <button
                    onClick={() => setEditingGoal({ goal: null, tag })}
                    className="text-sm text-gray-400 hover:text-green-500"
                  >
                    + 目标
                  </button>
                )}
                <button
                  onClick={() => { setEditingTag(tag); setShowTagForm(true) }}
                  className="text-sm text-gray-400 hover:text-brand"
                >
                  编辑
                </button>
                <button
                  onClick={async () => {
                    if (!confirm(`删除标签「${tag.name}」？`)) return
                    try {
                      await api.tags.remove(tag.id)
                      loadAll()
                    } catch (e) {
                      alert((e as Error).message)
                    }
                  }}
                  className="text-sm text-gray-400 hover:text-red-500"
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 目标管理 */}
      {goals.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">目标 / 习惯</h2>
          </div>
          <div className="space-y-2">
            {goals.map((goal) => {
              const tag = tags.find((t) => t.id === goal.tagId)
              return (
                <div key={goal.id} className="flex items-center justify-between rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 px-4 py-2.5">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: tag?.color ?? '#999' }} />
                    <div className="min-w-0">
                      <div className="font-medium text-sm truncate">{goal.title}</div>
                      <div className="text-xs text-gray-400">
                        {goal.type === 'count' ? '次数' : '时长(分)'} · 每{goal.period === 'daily' ? '日' : goal.period === 'weekly' ? '周' : goal.period === 'monthly' ? '月' : `${goal.periodDays}天`}
                        {' · '}目标 {goal.target}{goal.type === 'count' ? '次' : '分钟'}
                        {goal.current !== undefined && (
                          <span className={goal.current >= goal.target ? ' text-green-500 ml-1' : ' ml-1'}>
                            {' · '}已完成 {goal.current}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-2 flex-shrink-0">
                    <button
                      onClick={() => tag && setEditingGoal({ goal, tag })}
                      className="text-sm text-gray-400 hover:text-brand"
                    >
                      编辑
                    </button>
                    <button
                      onClick={async () => {
                        if (!confirm(`删除目标「${goal.title}」？`)) return
                        await api.goals.remove(goal.id)
                        loadGoals()
                      }}
                      className="text-sm text-gray-400 hover:text-red-500"
                    >
                      删除
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* 分类表单弹层 */}
      {showCatForm && (
        <CategoryForm
          category={editingCat}
          onClose={() => setShowCatForm(false)}
          onSaved={() => { setShowCatForm(false); loadAll() }}
        />
      )}
      {/* 标签表单弹层 */}
      {showTagForm && (
        <TagForm
          tag={editingTag}
          categories={categories}
          onClose={() => setShowTagForm(false)}
          onSaved={() => { setShowTagForm(false); loadAll() }}
        />
      )}
      {/* 目标编辑弹窗 */}
      {editingGoal && (
        <GoalForm
          goal={editingGoal.goal}
          tag={editingGoal.tag}
          onClose={() => setEditingGoal(null)}
          onSaved={() => { setEditingGoal(null); loadGoals() }}
        />
      )}
    </div>
  )
}

function CategoryForm({ category, onClose, onSaved }: {
  category: Category | null
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(category?.name ?? '')
  const [color, setColor] = useState(category?.color ?? COLORS[0])
  const [icon, setIcon] = useState(category?.icon ?? '')

  const save = async () => {
    if (!name.trim()) return
    if (category) {
      await api.categories.update(category.id, { name, color, icon: icon || null })
    } else {
      await api.categories.create({ name, color, icon: icon || null })
    }
    onSaved()
  }

  return (
    <Modal onClose={onClose} title={category ? '编辑分类' : '新建分类'}>
      <div className="space-y-4">
        <Field label="名称">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：日常、工作、宝宝"
            className="input" autoFocus />
        </Field>
        <Field label="图标（可选）">
          <input value={icon} onChange={(e) => setIcon(e.target.value)} placeholder="emoji 如：🏠"
            className="input" />
        </Field>
        <Field label="颜色">
          <ColorPicker value={color} onChange={setColor} />
        </Field>
      </div>
      <FormActions onCancel={onClose} onSave={save} />
    </Modal>
  )
}

function TagForm({ tag, categories, onClose, onSaved }: {
  tag: Tag | null
  categories: Category[]
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(tag?.name ?? '')
  const [color, setColor] = useState(tag?.color ?? COLORS[0])
  const [icon, setIcon] = useState(tag?.icon ?? '')
  const [categoryId, setCategoryId] = useState(tag?.categoryId ?? categories[0]?.id ?? '')
  const [trackType, setTrackType] = useState<'time' | 'count'>(tag?.trackType ?? 'time')

  const save = async () => {
    if (!name.trim()) return
    if (tag) {
      await api.tags.update(tag.id, { name, color, icon: icon || null, categoryId: categoryId || null, trackType })
    } else {
      await api.tags.create({ name, color, icon: icon || null, categoryId: categoryId || null, trackType })
    }
    onSaved()
  }

  return (
    <Modal onClose={onClose} title={tag ? '编辑标签' : '新建标签'}>
      <div className="space-y-4">
        <Field label="名称">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：吃饭、编码、陪玩"
            className="input" autoFocus />
        </Field>
        <Field label="所属分类">
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="input">
            <option value="">未分类</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </Field>
        <Field label="记录方式">
          <div className="flex gap-2">
            <button
              onClick={() => setTrackType('time')}
              className={`px-4 py-2 rounded-lg text-sm border ${trackType === 'time' ? 'bg-brand-100 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300 border-current font-medium' : 'text-gray-400 border-gray-300 dark:border-gray-700'}`}
            >
              ⏱ 时长计时
            </button>
            <button
              onClick={() => setTrackType('count')}
              className={`px-4 py-2 rounded-lg text-sm border ${trackType === 'count' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 border-current font-medium' : 'text-gray-400 border-gray-300 dark:border-gray-700'}`}
            >
              🔢 次数打卡
            </button>
          </div>
        </Field>
        <Field label="图标（可选）">
          <input value={icon} onChange={(e) => setIcon(e.target.value)} placeholder="emoji" className="input" />
        </Field>
        <Field label="颜色">
          <ColorPicker value={color} onChange={setColor} />
        </Field>
      </div>
      <FormActions onCancel={onClose} onSave={save} />
    </Modal>
  )
}

// 取色组件：原生取色板 + hex 输入 + 预设快捷色
const PRESET_COLORS = ['#6d5efc', '#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#ec4899', '#8b5cf6', '#14b8a6', '#64748b']

function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        {/* 原生取色板 */}
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-10 h-10 rounded-lg border border-gray-300 dark:border-gray-700 cursor-pointer bg-transparent p-0"
        />
        {/* 当前色块预览 + hex 输入 */}
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="input !w-32 font-mono text-sm"
          placeholder="#6d5efc"
        />
      </div>
      {/* 预设快捷色 */}
      <div className="flex gap-1.5 flex-wrap">
        {PRESET_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onChange(c)}
            className={`w-6 h-6 rounded-full border transition-transform hover:scale-110 ${value.toLowerCase() === c ? 'ring-2 ring-offset-1 ring-gray-400 border-transparent' : 'border-gray-200 dark:border-gray-700'}`}
            style={{ background: c }}
            title={c}
          />
        ))}
      </div>
    </div>
  )
}

// 通用组件
function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 rounded-2xl p-6 w-full max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold mb-4">{title}</h3>
        {children}
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm text-gray-500 mb-1">{label}</label>
      {children}
    </div>
  )
}

function FormActions({ onCancel, onSave }: { onCancel: () => void; onSave: () => void }) {
  return (
    <div className="flex justify-end gap-2 mt-6">
      <button onClick={onCancel} className="px-4 py-2 rounded-lg text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800">
        取消
      </button>
      <button onClick={onSave} className="px-4 py-2 rounded-lg text-sm bg-brand text-white hover:bg-brand-600">
        保存
      </button>
    </div>
  )
}

// 目标编辑弹窗
function GoalForm({ goal, tag, onClose, onSaved }: {
  goal: Goal | null
  tag: Tag
  onClose: () => void
  onSaved: () => void
}) {
  const [title, setTitle] = useState(goal?.title ?? `每日${tag.name}`)
  const [type, setType] = useState<'count' | 'time'>(goal?.type ?? (tag.trackType === 'count' ? 'count' : 'count'))
  const [target, setTarget] = useState(goal?.target ?? 1)
  const [period, setPeriod] = useState<'daily' | 'weekly' | 'monthly' | 'custom'>(goal?.period ?? 'daily')
  const [periodDays, setPeriodDays] = useState(goal?.periodDays ?? 7)

  const save = async () => {
    if (!title.trim()) return
    const data = { title: title.trim(), type, target, period, periodDays: period === 'custom' ? periodDays : null }
    if (goal) {
      await api.goals.update(goal.id, data)
    } else {
      await api.goals.create({ tagId: tag.id, ...data })
    }
    onSaved()
  }

  return (
    <Modal onClose={onClose} title={goal ? '编辑目标' : `为目标标签：${tag.name}`}>
      <div className="space-y-4">
        <Field label="目标名称">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如：每天喝水8杯"
            className="input" autoFocus />
        </Field>
        <Field label="目标类型">
          <div className="flex gap-2">
            <button
              onClick={() => setType('count')}
              className={`px-4 py-2 rounded-lg text-sm border ${type === 'count' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 border-current font-medium' : 'text-gray-400 border-gray-300 dark:border-gray-700'}`}
            >
              🔢 次数
            </button>
            <button
              onClick={() => setType('time')}
              className={`px-4 py-2 rounded-lg text-sm border ${type === 'time' ? 'bg-brand-100 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300 border-current font-medium' : 'text-gray-400 border-gray-300 dark:border-gray-700'}`}
            >
              ⏱ 时长(分钟)
            </button>
          </div>
        </Field>
        <Field label={`目标${type === 'count' ? '次数' : '分钟数'}`}>
          <input
            type="number"
            min={1}
            value={target}
            onChange={(e) => setTarget(Number(e.target.value))}
            className="input"
          />
        </Field>
        <Field label="统计周期">
          <select value={period} onChange={(e) => setPeriod(e.target.value as 'daily' | 'weekly' | 'monthly' | 'custom')} className="input">
            <option value="daily">每日</option>
            <option value="weekly">每周</option>
            <option value="monthly">每月</option>
            <option value="custom">自定义天数</option>
          </select>
        </Field>
        {period === 'custom' && (
          <Field label="周期天数">
            <input
              type="number"
              min={1}
              value={periodDays}
              onChange={(e) => setPeriodDays(Number(e.target.value))}
              className="input"
            />
          </Field>
        )}
      </div>
      <FormActions onCancel={onClose} onSave={save} />
    </Modal>
  )
}
