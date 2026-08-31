import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { api, ApiError } from '../api'
import { useNotesSocket, type NoteEvent } from '../hooks/useNotesSocket'
import type { NoteDetail, NoteAutocompleteEntry, RelatedEntities, EntityLinkType } from '../types'

type Mode = 'edit' | 'preview'

function renderMarkdown(content: string): string {
  const html = marked.parse(content || '', { async: false, breaks: true }) as string
  return DOMPurify.sanitize(html)
}

export default function NoteEditorPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [note, setNote] = useState<NoteDetail | null>(null)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [mode, setMode] = useState<Mode>('edit')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)

  // 冲突：服务器已有更新的版本
  const [conflict, setConflict] = useState<{ serverContent: string; serverRevision: number } | null>(null)
  const [mergeText, setMergeText] = useState('')
  const [showMerge, setShowMerge] = useState(false)

  // 供 WS 回调读取最新值
  const stateRef = useRef({ note, content, dirty, id })
  stateRef.current = { note, content, dirty, id }

  // [[ 补全
  const [ac, setAc] = useState(false)
  const [acResults, setAcResults] = useState<NoteAutocompleteEntry[]>([])

  // 关联的 TagTime 实体
  const [entities, setEntities] = useState<RelatedEntities | null>(null)

  const previewHtml = useMemo(() => renderMarkdown(content), [content])

  const refreshSilently = async (detail: NoteDetail) => {
    setNote(detail)
    setTitle(detail.title)
    setContent(detail.content)
    setDirty(false)
  }

  const load = async () => {
    if (!id) return
    try {
      const n = await api.notes.get(id)
      await refreshSilently(n)
    } catch (e: any) {
      setError(e.message)
    }
  }
  useEffect(() => { setConflict(null); load() }, [id])
  // 加载关联的 TagTime 实体
  const reloadEntities = () => {
    if (!id) return
    api.notes.entities(id).then(setEntities).catch(() => setEntities(null))
  }
  useEffect(() => {
    if (!id) return
    setEntities(null)
    api.notes.entities(id).then(setEntities).catch(() => setEntities(null))
  }, [id])

  // 服务器已有较新版本 → 进入冲突处理
  const openConflict = async () => {
    if (!id) return
    const s = await api.notes.get(id).catch(() => null)
    if (!s) return
    setConflict({ serverContent: s.content, serverRevision: s.revision })
    setMergeText(content)
    setShowMerge(false)
  }

  const save = async (): Promise<boolean> => {
    if (!note) return true
    setSaving(true)
    try {
      const r = await api.notes.update(note.id, { content, revision: note.revision })
      setNote((n) => (n ? { ...n, content, revision: r.revision } : n))
      setDirty(false)
      setConflict(null)
      setShowMerge(false)
      reloadEntities()
      return true
    } catch (e: any) {
      if (e instanceof ApiError && e.status === 409) {
        await openConflict()
        setError('版本冲突：服务器已更新，请选择处理方式')
      } else {
        setError(`保存失败：${e.message}`)
      }
      return false
    } finally {
      setSaving(false)
    }
  }

  const reloadDiscardLocal = async () => {
    if (!conflict) return
    if (!confirm('将丢弃本地的未保存修改，重新加载服务器版本，确定？')) return
    const s = conflict
    setContent(s.serverContent)
    setConflict(null)
    setShowMerge(false)
    setDirty(false)
    if (note) setNote({ ...note, revision: s.serverRevision })
  }

  const overwriteServer = async () => {
    if (!note || !conflict) return
    try {
      const r = await api.notes.update(note.id, { content, revision: conflict.serverRevision })
      setNote((n) => (n ? { ...n, content, revision: r.revision } : n))
      setConflict(null)
      setShowMerge(false)
      setDirty(false)
      reloadEntities()
    } catch (e: any) {
      setError(`覆盖失败：${e.message}`)
    }
  }

  const submitMerge = async () => {
    if (!note || !conflict || !showMerge) return
    try {
      const r = await api.notes.update(note.id, { content: mergeText, revision: conflict.serverRevision })
      setContent(mergeText)
      setNote((n) => (n ? { ...n, content: mergeText, revision: r.revision } : n))
      setConflict(null)
      setShowMerge(false)
      setDirty(false)
    } catch (e: any) {
      setError(`合并保存失败：${e.message}`)
    }
  }

  const rename = async () => {
    if (!note || !title.trim() || title.trim() === note.title) return
    try {
      const r = await api.notes.rename(note.id, { title: title.trim() })
      setNote((n) => (n ? { ...n, title: r.title, path: r.path } : n))
    } catch (e: any) {
      setError(`重命名失败：${e.message}`)
      setTitle(note.title)
    }
  }

  const remove = async () => {
    if (!note) return
    if (!confirm(`确定删除笔记「${note.title}」？其它文件中的引用不会删除。`)) return
    await api.notes.remove(note.id)
    navigate('/notes')
  }

  // WebSocket 实时事件
  const handleWs = (ev: NoteEvent) => {
    const cur = stateRef.current
    if (ev.type === 'note.deleted' && ev.id === cur.id) {
      navigate('/notes')
      return
    }
    if (cur.id && ev.id === cur.id && (ev.type === 'note.updated' || ev.type === 'note.created' || ev.type === 'note.renamed')) {
      const evRev = 'revision' in ev ? ev.revision : (cur.note?.revision ?? -1)
      const isSelfEcho = evRev <= (cur.note?.revision ?? -1) && !cur.dirty
      if (isSelfEcho) return
      if (cur.dirty) {
        void openConflict()
      } else {
        void load()
      }
    }
  }
  useNotesSocket(handleWs)

  // 移动端回到前台：即使 WS 断开也主动核对 revision
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible' && stateRef.current.id) {
        api.notes.get(stateRef.current.id).then((s) => {
          const cur = stateRef.current
          if (s.id !== cur.note?.id) return
          if (s.revision > (cur.note?.revision ?? -1)) {
            if (cur.dirty) void openConflict()
            else void load()
          }
        }).catch(() => {})
      }
    }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('focus', onVis)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('focus', onVis)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const triggerAutocomplete = (textarea: HTMLTextAreaElement) => {
    const v = textarea.value
    const pos = textarea.selectionStart
    const before = v.slice(0, pos)
    const m = /\[\[([^\[\]]*)$/.exec(before)
    if (m) {
      const q = m[1].trim()
      api.notes.autocomplete(q).then(setAcResults).catch(() => {})
      setAc(true)
    } else {
      setAc(false)
    }
  }

  const insertLink = (entry: NoteAutocompleteEntry) => {
    if (!taRef.current || !ac) return
    const ta = taRef.current
    const v = ta.value
    const pos = ta.selectionStart
    const before = v.slice(0, pos)
    const m = /\[\[([^\[\]]*)$/.exec(before)
    const startIdx = m ? pos - m[0].length : pos
    const insertText = `[[${entry.title}]]`
    const next = v.slice(0, startIdx) + insertText + v.slice(pos)
    setContent(next)
    setDirty(true)
    setAc(false)
    requestAnimationFrame(() => {
      ta.focus()
      ta.setSelectionRange(startIdx + insertText.length, startIdx + insertText.length)
    })
  }

  // 在光标处插入特殊链接占位；点击已有 entityKey 则填充实际键
  const insertEntityLink = (type: EntityLinkType, entityKey = '') => {
    if (!taRef.current) return
    const ta = taRef.current
    const v = ta.value
    const pos = ta.selectionStart
    const token = `[[${type}:${entityKey}]]`
    const next = v.slice(0, pos) + token + v.slice(pos)
    setContent(next)
    setDirty(true)
    requestAnimationFrame(() => {
      ta.focus()
      ta.setSelectionRange(pos + token.length, pos + token.length)
    })
  }

  // 跳转到 TagTime 现有页面
  const goEntity = (e: { type: EntityLinkType; entityKey: string }) => {
    if (e.type === 'tag') navigate('/tags')
    else if (e.type === 'todo') navigate('/todos')
    else if (e.type === 'date') navigate(`/calendar?date=${e.entityKey}`)
    else navigate('/') // memo → 主页（计时/日记面板）
  }

  if (error && !note) {
    return <div className="p-6 text-sm text-red-500">{error}</div>
  }
  if (!note) {
    return <div className="p-6 text-sm text-gray-400">加载中…</div>
  }

  return (
    <div className="max-w-4xl mx-auto space-y-3">
      <div className="flex items-center justify-between gap-2">
        <button onClick={() => navigate('/notes')} className="text-sm text-brand hover:underline">
          ← 返回列表
        </button>
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate(`/notes/${note.id}/graph`)}
            className="text-sm px-2.5 py-1 rounded-lg border border-gray-200 dark:border-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          >
            🕸 关联图
          </button>
          {dirty ? (
            <span className="text-xs text-amber-500">● 有未保存修改</span>
          ) : (
            <span className="text-xs text-gray-400">已保存</span>
          )}
          <button
            onClick={remove}
            className="px-2.5 py-1.5 text-xs text-red-500 border border-red-200 dark:border-red-900 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20"
          >
            删除
          </button>
          <button
            onClick={save}
            disabled={saving || dirty === false}
            className="px-3 py-1.5 text-sm bg-brand text-white rounded-xl disabled:opacity-40"
          >
            保存
          </button>
        </div>
      </div>

      {error && <div className="text-xs text-red-500">{error}</div>}

      {conflict && (
        <div className="rounded-xl border border-amber-400/50 bg-amber-50 dark:bg-amber-900/20 p-3 space-y-2">
          <div className="text-sm font-semibold text-amber-700 dark:text-amber-300">
            ⚠ 版本冲突：服务器版本已更新到 rev {conflict.serverRevision}，你的本地修改尚未保存。
          </div>
          {showMerge && (
            <div className="space-y-2">
              <textarea
                value={mergeText}
                onChange={(e) => setMergeText(e.target.value)}
                className="w-full h-40 px-3 py-2 text-sm font-mono rounded-lg border border-amber-300 dark:border-amber-800 bg-white dark:bg-gray-900 focus:outline-none"
                placeholder="在此合并本地与服务器内容…"
              />
              <details className="text-xs text-gray-500">
                <summary>查看服务器版本（可复制）</summary>
                <pre className="whitespace-pre-wrap mt-1 p-2 border border-gray-200 dark:border-gray-800 rounded-lg max-h-40 overflow-auto">{conflict.serverContent}</pre>
              </details>
              <button onClick={submitMerge} className="px-3 py-1.5 text-sm bg-amber-500 text-white rounded-lg">
                提交合并结果
              </button>
            </div>
          )}
          {!showMerge && (
            <div className="flex flex-wrap gap-2">
              <button onClick={overwriteServer} className="px-3 py-1.5 text-sm bg-brand text-white rounded-lg">
                覆盖服务器（保存本地）
              </button>
              <button onClick={() => setShowMerge(true)} className="px-3 py-1.5 text-sm bg-amber-500 text-white rounded-lg">
                手动合并
              </button>
              <button onClick={reloadDiscardLocal} className="px-3 py-1.5 text-sm border border-amber-300 dark:border-amber-700 rounded-lg">
                重新加载（丢弃本地）
              </button>
            </div>
          )}
        </div>
      )}

      <input
        value={title}
        onChange={(e) => { setTitle(e.target.value); setDirty(true) }}
        onBlur={rename}
        className="w-full px-1 py-1 text-2xl font-bold bg-transparent text-gray-900 dark:text-gray-50 focus:outline-none"
        placeholder="笔记标题"
      />

      <div className="flex items-center justify-between text-xs text-gray-400 dark:text-gray-500">
        <span className="truncate">{note.path} · rev {note.revision}</span>
        <div className="flex gap-1">
          <button
            onClick={() => setMode('edit')}
            className={`px-2.5 py-1 rounded-lg ${mode === 'edit' ? 'bg-brand text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-500'}`}
          >
            编辑
          </button>
          <button
            onClick={() => setMode('preview')}
            className={`px-2.5 py-1 rounded-lg ${mode === 'preview' ? 'bg-brand text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-500'}`}
          >
            预览
          </button>
        </div>
      </div>

      <div className="relative">
        {mode === 'edit' ? (
          <textarea
            ref={taRef}
            value={content}
            onChange={(e) => { setContent(e.target.value); setDirty(true); triggerAutocomplete(e.target) }}
            onKeyDown={(e) => { if (e.key === 'Escape') setAc(false) }}
            spellCheck={false}
            className="w-full min-h-[60vh] px-3 py-3 text-sm font-mono rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-brand/40 resize-y"
            placeholder="支持 Markdown，输入 [[ 可引用其它笔记"
          />
        ) : (
          <div
            className="min-h-[60vh] px-4 py-4 text-sm rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 prose-preview"
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
        )}
        {ac && (
          <div className="absolute left-0 right-0 bottom-0 max-h-48 overflow-auto rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-lg z-10">
            {acResults.length === 0 ? (
              <div className="px-3 py-2 text-xs text-gray-400">未找到匹配笔记（将作为未解析链接保留）</div>
            ) : (
              acResults.map((r) => (
                <button
                  key={r.id}
                  onClick={() => insertLink(r)}
                  className="w-full px-3 py-2 text-left text-sm hover:bg-brand/10"
                >
                  <span className="text-brand">{r.title}</span>
                  <span className="ml-2 text-xs text-gray-400">{r.path}</span>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {(note.outLinks.length > 0 || note.inLinks.length > 0) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="rounded-xl border border-gray-100 dark:border-gray-800 p-3">
            <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-2">出链 ({note.outLinks.length})</div>
            <ul className="space-y-1">
              {note.outLinks.map((l) => (
                <li key={l.id} className="text-sm">
                  {l.targetNoteId ? (
                    <button onClick={() => navigate(`/notes/${l.targetNoteId}`)} className="text-brand hover:underline">
                      {l.linkText || l.targetTitle}
                    </button>
                  ) : (
                    <span className="text-gray-400 line-through">{l.targetTitle}（未解析）</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-xl border border-gray-100 dark:border-gray-800 p-3">
            <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-2">链接到此笔记 ({note.inLinks.length})</div>
            <ul className="space-y-1">
              {note.inLinks.map((l) => (
                <li key={l.sourceNoteId} className="text-sm">
                  <button onClick={() => navigate(`/notes/${l.sourceNoteId}`)} className="text-brand hover:underline">
                    {l.sourceTitle}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {entities && (
        <div className="rounded-xl border border-gray-100 dark:border-gray-800 p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-semibold text-gray-500 dark:text-gray-400">关联的 TagTime</div>
            <div className="flex gap-1 text-xs">
              <button onClick={() => insertEntityLink('tag')} className="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 hover:bg-brand/10" title="插入 [[tag:]]">+标签</button>
              <button onClick={() => insertEntityLink('todo')} className="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 hover:bg-brand/10" title="插入 [[todo:]]">+待办</button>
              <button onClick={() => insertEntityLink('date')} className="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 hover:bg-brand/10" title="插入 [[date:]]">+日期</button>
              <button onClick={() => insertEntityLink('memo')} className="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 hover:bg-brand/10" title="插入 [[memo:]]">+日记</button>
            </div>
          </div>
          {(['tags', 'todos', 'dates', 'memos'] as const).filter((k) => entities[k].length > 0).length === 0 ? (
            <div className="text-xs text-gray-400">未关联任何标签 / 待办 / 日期 / 日记，可点击右上角插入特殊链接，如 [[tag:工作]]、[[date:2026-08-31]]。</div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
              {entities.tags.length > 0 && (
                <EntityGroup
                  label={`🏷 标签 (${entities.tags.length})`}
                  items={entities.tags}
                  onGo={goEntity}
                />
              )}
              {entities.todos.length > 0 && (
                <EntityGroup
                  label={`✓ 待办 (${entities.todos.length})`}
                  items={entities.todos}
                  onGo={goEntity}
                />
              )}
              {entities.dates.length > 0 && (
                <EntityGroup
                  label={`📅 日期 (${entities.dates.length})`}
                  items={entities.dates}
                  onGo={goEntity}
                />
              )}
              {entities.memos.length > 0 && (
                <EntityGroup
                  label={`📓 日记 (${entities.memos.length})`}
                  items={entities.memos}
                  onGo={goEntity}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function EntityGroup({ label, items, onGo }: {
  label: string
  items: RelatedEntities['tags']
  onGo: (e: { type: EntityLinkType; entityKey: string }) => void
}) {
  return (
    <div>
      <div className="text-xs text-gray-400 mb-1">{label}</div>
      <ul className="space-y-1">
        {items.map((e) => (
          <li key={`${e.type}:${e.entityKey}`} className="text-sm flex items-center gap-1.5">
            {e.resolved ? (
              // 类型统一视为可跳转
              <button onClick={() => onGo(e)} className="text-brand hover:underline truncate">
                {e.linkText || e.name || e.entityKey}
              </button>
            ) : (
              <span className="text-gray-400 line-through truncate" title={`[[${e.type}:${e.entityKey}]]`}>
                {e.linkText || e.entityKey}（失效）
              </span>
            )}
            {e.type === 'memo' && e.timeEntry && (
              <span
                className="text-[10px] text-gray-500 bg-gray-100 dark:bg-gray-800 rounded px-1 py-0.5 whitespace-nowrap"
                title="该日记关联的计时记录"
              >
                ⏱{e.timeEntry.tagName || '记录'}{e.timeEntry.endTime ? '' : '·进行中'}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}