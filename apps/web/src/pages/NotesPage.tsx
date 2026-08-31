import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import type { NoteListEntry } from '../types'

export default function NotesPage() {
  const navigate = useNavigate()
  const [notes, setNotes] = useState<NoteListEntry[]>([])
  const [q, setQ] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [busy, setBusy] = useState(false)

  const load = async () => {
    setNotes(await api.notes.list(q || undefined))
  }
  useEffect(() => { load() }, [q])

  const createNew = async () => {
    if (!newTitle.trim() || busy) return
    setBusy(true)
    try {
      const created = await api.notes.create({ title: newTitle.trim() })
      setNewTitle('')
      setShowNew(false)
      navigate(`/notes/${created.id}`)
    } catch (e: any) {
      alert(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-bold text-gray-800 dark:text-gray-100">📝 笔记</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate('/notes/graph')}
            className="px-3 py-1.5 text-sm rounded-xl border border-gray-200 dark:border-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          >
            🕸 关系图
          </button>
          <button
            onClick={() => setShowNew((v) => !v)}
            className="px-3 py-1.5 text-sm bg-brand text-white rounded-xl hover:bg-brand-600 transition-colors"
          >
            ＋ 新建笔记
          </button>
        </div>
      </div>

      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="🔍 搜索标题 / 路径…"
        className="w-full px-3 py-2 text-sm rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-brand/40"
      />

      {showNew && (
        <div className="flex gap-2">
          <input
            autoFocus
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') createNew() }}
            placeholder="输入笔记标题…"
            className="flex-1 px-3 py-2 text-sm rounded-xl border border-brand/40 dark:border-brand/30 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 focus:outline-none"
          />
          <button
            onClick={createNew}
            disabled={busy || !newTitle.trim()}
            className="px-4 py-2 text-sm bg-brand text-white rounded-xl disabled:opacity-50"
          >
            创建
          </button>
        </div>
      )}

      {notes.length === 0 ? (
        <div className="text-center py-16 text-sm text-gray-400 dark:text-gray-500">
          还没有笔记，点击右上角新建一篇。
        </div>
      ) : (
        <div className="divide-y divide-gray-100 dark:divide-gray-800 rounded-2xl border border-gray-100 dark:border-gray-800 overflow-hidden bg-white dark:bg-gray-900">
          {notes.map((n) => (
            <button
              key={n.id}
              onClick={() => navigate(`/notes/${n.id}`)}
              className="w-full flex items-center justify-between gap-2 px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors"
            >
              <div className="min-w-0">
                <div className="font-medium text-gray-800 dark:text-gray-100 truncate">{n.title}</div>
                <div className="text-xs text-gray-400 dark:text-gray-500 truncate">{n.path}</div>
              </div>
              <div className="shrink-0 flex items-center gap-2 text-xs text-gray-400 dark:text-gray-500">
                <span title="出链">→ {n.outLinkCount}</span>
                <span title="反链">← {n.inLinkCount}</span>
                <span className="tabular-nums">{new Date(n.updatedAt).toLocaleDateString('zh-CN')}</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}