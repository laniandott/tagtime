import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { marked } from 'marked'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import DOMPurify from 'dompurify'
import { api, ApiError } from '../api'
import { useNotesSocket, type NoteEvent } from '../hooks/useNotesSocket'
import type { NoteDetail, RelatedEntities, EntityLinkType } from '../types'
import MarkdownEditor, {
  insertAroundSelection as cmInsertAround,
  prefixSelectedLines as cmPrefixLines,
  insertTextAtCursor as cmInsertText,
} from '../editor/MarkdownEditor'
import type { EditorView } from '@codemirror/view'
import { codeRanges } from '../editor/codeRanges'
import { createUniquePlaceholder } from '../editor/placeholders'

type Mode = 'live' | 'edit' | 'split' | 'preview'

function normalizeMathExpression(expression: string): string {
  // 用户笔记里常用 Markdown 的转义下划线（\\_），在 LaTeX 中应还原为下标符号。
  return expression.replace(/\\_/g, '_').trim()
}

function isInsideRange(position: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([start, end]) => position >= start && position < end)
}

function renderMarkdown(content: string): string {
  const source = content || ''
  const ranges = codeRanges(source)
  const mathTokens: Array<{ token: string; html: string; display: boolean }> = []
  const usedPlaceholders = new Set<string>()
  const mathPattern = /\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$\$[\s\S]*?\$\$|\$[^\n$]+?\$/g
  const markdown = source.replace(mathPattern, (full, offset: number) => {
    if (isInsideRange(offset, ranges)) return full
    const display = full.startsWith('$$') || full.startsWith('\\[')
    const expression = display
      ? full.startsWith('$$')
        ? full.slice(2, -2)
        : full.slice(2, -2)
      : full.startsWith('\\(')
        ? full.slice(2, -2)
        : full.slice(1, -1)
    const token = createUniquePlaceholder('TAGTIMEMATH', source, usedPlaceholders)
    const html = katex.renderToString(normalizeMathExpression(expression), {
      displayMode: display,
      throwOnError: false,
      strict: 'ignore',
      trust: false,
    })
    mathTokens.push({ token, html, display })
    return token
  })
  let html = marked.parse(markdown, { async: false, breaks: true }) as string
  for (const { token, html: mathHtml, display } of mathTokens) {
    const paragraph = new RegExp(`<p>\\s*${token}\\s*</p>`, 'g')
    html = html.replace(paragraph, display ? mathHtml : `<span class="math-inline">${mathHtml}</span>`)
    html = html.replaceAll(token, display ? mathHtml : `<span class="math-inline">${mathHtml}</span>`)
  }
  return DOMPurify.sanitize(html)
}

function folderFromPath(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}

export default function NoteEditorPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [note, setNote] = useState<NoteDetail | null>(null)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [mode, setMode] = useState<Mode>('live')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const editorRef = useRef<EditorView | null>(null)
  const localMutationRef = useRef(false)
  const localMutationTimerRef = useRef<number | null>(null)
  const loadSequence = useRef(0)
  const folderRequest = useRef(0)
  const entitiesRequest = useRef(0)
  const [folders, setFolders] = useState<string[]>([])
  const [compactHeader, setCompactHeader] = useState(false)

  useEffect(() => {
    const updateHeader = () => {
      const next = window.scrollY > 72
      setCompactHeader((current) => current === next ? current : next)
    }
    updateHeader()
    window.addEventListener('scroll', updateHeader, { passive: true })
    return () => window.removeEventListener('scroll', updateHeader)
  }, [])

  const beginLocalMutation = () => {
    if (localMutationTimerRef.current !== null) window.clearTimeout(localMutationTimerRef.current)
    localMutationRef.current = true
  }
  const finishLocalMutation = () => {
    localMutationTimerRef.current = window.setTimeout(() => {
      localMutationRef.current = false
      localMutationTimerRef.current = null
    }, 500)
  }

  // 冲突：服务器已有更新的版本
  const [conflict, setConflict] = useState<{ serverContent: string; serverRevision: number } | null>(null)
  const [mergeText, setMergeText] = useState('')
  const [showMerge, setShowMerge] = useState(false)

  // 供 WS 回调读取最新值
  const stateRef = useRef({ note, content, dirty, id })
  stateRef.current = { note, content, dirty, id }

  // 关联的 TagTime 实体
  const [entities, setEntities] = useState<RelatedEntities | null>(null)

  const previewHtml = useMemo(() => renderMarkdown(content), [content])

  const changeMode = (next: Mode) => {
    setMode(next)
  }

  const refreshSilently = async (detail: NoteDetail) => {
    setNote(detail)
    setTitle(detail.title)
    setContent(detail.content)
    setDirty(false)
  }

  const load = async () => {
    if (!id) return
    const sequence = ++loadSequence.current
    try {
      const n = await api.notes.get(id)
      if (sequence !== loadSequence.current) return
      await refreshSilently(n)
      setError('')
    } catch (e: any) {
      if (sequence !== loadSequence.current) return
      setError(e.message)
    }
  }
  useEffect(() => {
    setConflict(null)
    void load()
    const sequence = ++folderRequest.current
    api.notes.folders()
      .then((result) => { if (sequence === folderRequest.current) setFolders(result.folders) })
      .catch(() => { if (sequence === folderRequest.current) setFolders([]) })
  }, [id])
  // 加载关联的 TagTime 实体
  const reloadEntities = () => {
    if (!id) return
    const sequence = ++entitiesRequest.current
    api.notes.entities(id)
      .then((result) => { if (sequence === entitiesRequest.current) setEntities(result) })
      .catch(() => { if (sequence === entitiesRequest.current) setEntities(null) })
  }
  useEffect(() => {
    if (!id) return
    setEntities(null)
    reloadEntities()
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
    beginLocalMutation()
    try {
      const r = await api.notes.update(note.id, { content, revision: note.revision })
      setNote((n) => (n ? { ...n, content, revision: r.revision } : n))
      setDirty(false)
      setConflict(null)
      setShowMerge(false)
      setError('')
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
      finishLocalMutation()
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
    beginLocalMutation()
    try {
      const r = await api.notes.update(note.id, { content, revision: conflict.serverRevision })
      setNote((n) => (n ? { ...n, content, revision: r.revision } : n))
      setConflict(null)
      setShowMerge(false)
      setDirty(false)
      setError('')
      reloadEntities()
    } catch (e: any) {
      setError(`覆盖失败：${e.message}`)
    } finally {
      finishLocalMutation()
    }
  }

  const submitMerge = async () => {
    if (!note || !conflict || !showMerge) return
    beginLocalMutation()
    try {
      const r = await api.notes.update(note.id, { content: mergeText, revision: conflict.serverRevision })
      setContent(mergeText)
      setNote((n) => (n ? { ...n, content: mergeText, revision: r.revision } : n))
      setConflict(null)
      setShowMerge(false)
      setDirty(false)
      setError('')
      reloadEntities()
    } catch (e: any) {
      setError(`合并保存失败：${e.message}`)
    } finally {
      finishLocalMutation()
    }
  }

  const rename = async () => {
    if (!note || !title.trim() || title.trim() === note.title) return
    beginLocalMutation()
    try {
      const r = await api.notes.rename(note.id, { title: title.trim() })
      setNote((n) => (n ? { ...n, title: r.title, path: r.path, revision: r.revision } : n))
      setError('')
    } catch (e: any) {
      setError(`重命名失败：${e.message}`)
      setTitle(note.title)
    } finally {
      finishLocalMutation()
    }
  }

  const moveToFolder = async (folder: string) => {
    if (!note || folder === folderFromPath(note.path)) return
    beginLocalMutation()
    try {
      const result = await api.notes.rename(note.id, { folder })
      setNote((current) => current ? { ...current, path: result.path, revision: result.revision } : current)
      setError('')
    } catch (e: any) {
      setError(`移动失败：${e.message}`)
    } finally {
      finishLocalMutation()
    }
  }

  const remove = async () => {
    if (!note) return
    if (!confirm(`确定删除笔记「${note.title}」？其它文件中的引用不会删除。`)) return
    try {
      await api.notes.remove(note.id)
      navigate('/notes')
    } catch (e: any) {
      setError(`删除失败：${e.message}`)
    }
  }

  // WebSocket 实时事件
  const handleWs = (ev: NoteEvent) => {
    const cur = stateRef.current
    if (ev.type === 'note.deleted' && ev.id === cur.id) {
      navigate('/notes')
      return
    }
    if (ev.id === cur.id && localMutationRef.current) return
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

  // 工具栏命令辅助：作用于 CodeMirror EditorView（live/edit/split 下均有视图）
  const runTool = (fn: (view: EditorView) => void) => {
    const view = editorRef.current
    if (view) fn(view)
  }

  // 在编辑器光标处插入特殊链接占位；点击已有 entityKey 则填充实际键
  const insertEntityLink = (type: EntityLinkType, entityKey = '') => {
    runTool((view) => cmInsertText(view, `[[${type}:${entityKey}]]`))
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

  const markdownTools = [
    { label: 'H', title: '标题', action: () => runTool((v) => cmPrefixLines(v, '## ')) },
    { label: 'B', title: '粗体', action: () => runTool((v) => cmInsertAround(v, '**', '**', '粗体文字')) },
    { label: 'I', title: '斜体', action: () => runTool((v) => cmInsertAround(v, '*', '*', '斜体文字')) },
    { label: 'S', title: '删除线', action: () => runTool((v) => cmInsertAround(v, '~~', '~~', '删除文字')) },
    { label: '•', title: '无序列表', action: () => runTool((v) => cmPrefixLines(v, '- ')) },
    { label: '1.', title: '有序列表', action: () => runTool((v) => cmPrefixLines(v, '1. ')) },
    { label: '☐', title: '任务列表', action: () => runTool((v) => cmPrefixLines(v, '- [ ] ')) },
    { label: '❯', title: '引用', action: () => runTool((v) => cmPrefixLines(v, '> ')) },
    { label: '<>', title: '行内代码', action: () => runTool((v) => cmInsertAround(v, '`', '`', '代码')) },
    { label: '[ ]', title: '链接', action: () => runTool((v) => cmInsertAround(v, '[', '](https://)', '链接文字')) },
    { label: '```', title: '代码块', action: () => runTool((v) => cmInsertAround(v, '```\n', '\n```', '代码')) },
  ]
  const modeButtonClass = (active: boolean) => `rounded-md ${compactHeader ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1'} ${active ? 'bg-brand text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-500'}`

  return (
    <div className="max-w-6xl mx-auto space-y-3">
      <div className={`sticky top-14 z-[9] -mx-2 px-2 sm:-mx-4 sm:px-4 bg-gray-50/95 dark:bg-gray-950/95 backdrop-blur-md transition-all duration-200 ${compactHeader ? 'border-b border-gray-200 py-1 shadow-sm dark:border-gray-800' : 'border-b border-transparent py-1.5'}`}>
        <div className={`flex items-center justify-between ${compactHeader ? 'gap-1' : 'gap-2'}`}>
          <button onClick={() => navigate('/notes')} className="shrink-0 text-sm text-brand hover:underline">
            ← 返回列表
          </button>
          <div className={`flex min-w-0 items-center ${compactHeader ? 'gap-1' : 'gap-2'}`}>
            <button
              onClick={() => navigate(`/notes/${note.id}/graph`)}
              className={`${compactHeader ? 'px-2 py-1 text-xs' : 'px-2.5 py-1 text-sm'} rounded-lg border border-gray-200 dark:border-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors`}
            >
              🕸 关联图
            </button>
            {dirty ? (
              <span className="whitespace-nowrap text-xs text-amber-500">● 有未保存修改</span>
            ) : (
              <span className="whitespace-nowrap text-xs text-gray-400">已保存</span>
            )}
            <button
              onClick={remove}
              className={`${compactHeader ? 'px-2 py-1' : 'px-2.5 py-1.5'} whitespace-nowrap text-xs text-red-500 border border-red-200 dark:border-red-900 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20`}
            >
              删除
            </button>
            <button
              onClick={save}
              disabled={saving || dirty === false}
              className={`${compactHeader ? 'px-2.5 py-1' : 'px-3 py-1.5'} whitespace-nowrap text-sm bg-brand text-white rounded-lg disabled:opacity-40`}
            >
              保存
            </button>
          </div>
        </div>

        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={rename}
          className={`mt-1 w-full min-w-0 bg-transparent px-1 font-bold text-gray-900 transition-[font-size] focus:outline-none dark:text-gray-50 ${compactHeader ? 'py-0.5 text-base' : 'py-1 text-2xl'}`}
          placeholder="笔记标题"
        />

        <div className={`flex flex-wrap items-center justify-between gap-2 text-xs text-gray-400 dark:text-gray-500 ${compactHeader ? 'mt-0.5' : ''}`}>
          <div className="flex min-w-0 items-center gap-2">
            <select
              value={folderFromPath(note.path)}
              onChange={(event) => void moveToFolder(event.target.value)}
              className="max-w-[220px] rounded-md border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-2 py-1 text-xs text-gray-600 dark:text-gray-300"
              title="移动到文件夹"
            >
              <option value="">根目录</option>
              {folders.map((folder) => <option key={folder} value={folder}>{folder}</option>)}
            </select>
            <span className={`truncate ${compactHeader ? 'hidden' : ''}`}>{note.path} · rev {note.revision}</span>
          </div>
          <div className={`flex gap-1 ${compactHeader ? 'shrink-0' : ''}`} role="group" aria-label="编辑器视图">
            <button
              onClick={() => changeMode('live')}
              className={modeButtonClass(mode === 'live')}
              title="光标所在行显示源码，其余行实时渲染"
            >
              所见即所得
            </button>
            <button
              onClick={() => changeMode('edit')}
              className={modeButtonClass(mode === 'edit')}
            >
              编辑
            </button>
            <button
              onClick={() => changeMode('split')}
              className={modeButtonClass(mode === 'split')}
            >
              分栏
            </button>
            <button
              onClick={() => changeMode('preview')}
              className={modeButtonClass(mode === 'preview')}
            >
              预览
            </button>
          </div>
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

      {mode !== 'preview' && (
        <div className="flex min-h-9 items-center gap-1 overflow-x-auto border-y border-gray-200 dark:border-gray-800 py-1" role="toolbar" aria-label="Markdown 格式">
          {markdownTools.map((tool) => (
            <button
              key={tool.title}
              type="button"
              title={tool.title}
              aria-label={tool.title}
              onMouseDown={(event) => event.preventDefault()}
              onClick={tool.action}
              className={`shrink-0 min-w-8 h-7 px-2 rounded-md text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 ${tool.label === 'B' ? 'font-bold' : tool.label === 'I' ? 'italic' : ''}`}
            >
              {tool.label}
            </button>
          ))}
        </div>
      )}

      {mode === 'live' && (
        <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-3 py-2 min-h-[48vh] md:min-h-[60vh]">
          <div className="mb-2 text-xs text-gray-400 dark:text-gray-500">
            光标所在行显示源码，移开后该行实时渲染
          </div>
          <MarkdownEditor
            key={note.id}
            value={content}
            mode="live"
            editorRef={editorRef}
            onChange={(next) => { setContent(next); setDirty(true) }}
            autoFocus={false}
          />
        </div>
      )}

      {mode !== 'live' && (
        <div className={mode === 'split' ? 'grid grid-cols-1 md:grid-cols-2 gap-2' : ''}>
          {mode !== 'preview' && (
            <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-3 py-2 min-h-[48vh] md:min-h-[60vh]">
              <MarkdownEditor
                key={note.id}
                value={content}
                mode="source"
                editorRef={editorRef}
                onChange={(next) => { setContent(next); setDirty(true) }}
                autoFocus={false}
              />
            </div>
          )}
          {mode !== 'edit' && (
            <div
              className="min-h-[48vh] md:min-h-[60vh] px-4 py-4 text-sm rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 prose-preview overflow-auto"
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />
          )}
        </div>
      )}

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
