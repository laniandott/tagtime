import { useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import type { Category, Tag } from '../types'

const COLORS = ['#6d5efc', '#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#ec4899', '#8b5cf6', '#14b8a6', '#64748b']

export default function TagsPage() {
  const { categories, tags, loadAll } = useStore()
  const [showCatForm, setShowCatForm] = useState(false)
  const [showTagForm, setShowTagForm] = useState(false)
  const [editingCat, setEditingCat] = useState<Category | null>(null)
  const [editingTag, setEditingTag] = useState<Tag | null>(null)

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
                <span
                  className="text-xs px-2 py-0.5 rounded-full"
                  style={{ background: tag.category?.color ?? '#e5e7eb', color: tag.category ? '#fff' : '#6b7280' }}
                >
                  {tag.category?.name ?? '未分类'}
                </span>
              </div>
              <div className="flex gap-2">
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

  const save = async () => {
    if (!name.trim()) return
    if (tag) {
      await api.tags.update(tag.id, { name, color, icon: icon || null, categoryId: categoryId || null })
    } else {
      await api.tags.create({ name, color, icon: icon || null, categoryId: categoryId || null })
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
