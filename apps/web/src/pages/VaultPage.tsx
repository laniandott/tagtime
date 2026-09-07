import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { EditorView } from '@codemirror/view'
import { AtomicCodeMirrorEditor } from '@atomic-editor/editor'
import { wikiLinks } from '@atomic-editor/editor'
import '@atomic-editor/editor/styles.css'
import { api, ApiError } from '../api'
import { useNotesSocket, type NoteEvent } from '../hooks/useNotesSocket'
import type { NoteDetail, NoteListEntry, RelatedEntities, EntityLinkType } from '../types'
import MarkdownEditor, {
  insertAroundSelection as cmInsertAround,
  prefixSelectedLines as cmPrefixLines,
} from '../editor/MarkdownEditor'
import { renderMarkdown } from '../editor/markdownPreview'
import { atomicMathPreview } from '../editor/atomicMathPreview'
import { buildNoteTree, type NoteFolderNode } from './NotesPage'
import 'katex/dist/katex.min.css'

type ViewMode = 'live' | 'edit' | 'split' | 'preview'

type Conflict = {
  serverContent: string
  serverRevision: number
}

type VaultDocument = {
  note: NoteDetail
  title: string
  content: string
  dirty: boolean
  saving: boolean
  error: string
  conflict: Conflict | null
}

function folderFromPath(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}

function shortName(path: string): string {
  return path.split('/').pop()?.replace(/\.md$/i, '') || path
}

function isEntityTarget(target: string): boolean {
  return /^(tag|todo|date|memo):/i.test(target)
}

export default function VaultPage() {
  const { id } = useParams<{ id?: string }>()
  const navigate = useNavigate()
  const [notes, setNotes] = useState<NoteListEntry[]>([])
  const [folders, setFolders] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null)
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [vaultPath, setVaultPath] = useState('')
  const [vaultPathDraft, setVaultPathDraft] = useState('')
  const [vaultSource, setVaultSource] = useState<'environment' | 'config' | ''>('')
  const [vaultSettingsOpen, setVaultSettingsOpen] = useState(false)
  const [vaultBusy, setVaultBusy] = useState(false)
  const [openTabs, setOpenTabs] = useState<string[]>([])
  const [documents, setDocuments] = useState<Record<string, VaultDocument>>({})
  const [entities, setEntities] = useState<RelatedEntities | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('live')
  const [vaultError, setVaultError] = useState('')
  const editorRef = useRef<EditorView | null>(null)
  const documentsRef = useRef(documents)
  const activeIdRef = useRef(id)
  const loadSequence = useRef(0)
  const entitiesRequest = useRef(0)
  const contentScrollRef = useRef<HTMLElement | null>(null)
  documentsRef.current = documents
  activeIdRef.current = id

  const updateDocument = (noteId: string, patch: Partial<VaultDocument>) => {
    setDocuments((current) => current[noteId] ? { ...current, [noteId]: { ...current[noteId], ...patch } } : current)
  }

  const loadVault = async () => {
    const sequence = ++loadSequence.current
    try {
      const [nextNotes, folderResult, vault] = await Promise.all([
        api.notes.list(query || undefined),
        api.notes.folders(),
        api.notes.vault(),
      ])
      if (sequence !== loadSequence.current) return
      setNotes(nextNotes)
      setFolders(folderResult.folders)
      setVaultPath(vault.path)
      setVaultSource(vault.source)
      setVaultPathDraft((current) => current || vault.path)
      setExpandedFolders((current) => current.size ? current : new Set(folderResult.folders))
      setDocuments((current) => {
        const next = { ...current }
        for (const entry of nextNotes) {
          const doc = next[entry.id]
          if (doc) next[entry.id] = { ...doc, note: { ...doc.note, ...entry }, title: doc.title || entry.title }
        }
        return next
      })
      setVaultError('')
    } catch (error: any) {
      if (sequence === loadSequence.current) setVaultError(error.message || '笔记库加载失败')
    }
  }

  const openVaultSettings = async () => {
    try {
      const vault = await api.notes.vault()
      setVaultPath(vault.path)
      setVaultPathDraft(vault.path)
      setVaultSource(vault.source)
      setVaultSettingsOpen(true)
      setVaultError('')
    } catch (error: any) {
      setVaultError(error.message || '读取文件库设置失败')
    }
  }

  const switchVault = async () => {
    const nextPath = vaultPathDraft.trim()
    if (!nextPath || vaultBusy) return
    if (!confirm('切换文件库后，TagTime 会重新扫描该文件夹中的 Markdown 文件。不会移动或删除任何文件，笔记索引和笔记 ID 可能变化。继续吗？')) return
    setVaultBusy(true)
    try {
      const result = await api.notes.setVault(nextPath)
      setVaultPath(result.path)
      setVaultPathDraft(result.path)
      setVaultSettingsOpen(false)
      setDocuments({})
      setOpenTabs([])
      setEntities(null)
      navigate('/notes')
      await loadVault()
    } catch (error: any) {
      setVaultError(error.message || '切换文件库失败')
    } finally {
      setVaultBusy(false)
    }
  }

  const loadDocument = async (noteId: string) => {
    try {
      const detail = await api.notes.get(noteId)
      const current = documentsRef.current[noteId]
      if (current?.dirty) {
        updateDocument(noteId, {
          conflict: { serverContent: detail.content, serverRevision: detail.revision },
        })
        return
      }
      setDocuments((all) => ({
        ...all,
        [noteId]: {
          note: detail,
          title: detail.title,
          content: detail.content,
          dirty: false,
          saving: false,
          error: '',
          conflict: null,
        },
      }))
      setVaultError('')
    } catch (error: any) {
      setVaultError(error.message || '笔记加载失败')
    }
  }

  useEffect(() => { void loadVault() }, [query])

  useEffect(() => {
    const sequence = ++entitiesRequest.current
    if (!id) {
      setEntities(null)
      return
    }
    setOpenTabs((current) => current.includes(id) ? current : [...current, id])
    void loadDocument(id)
    setEntities(null)
    api.notes.entities(id).then((result) => {
      if (sequence === entitiesRequest.current) setEntities(result)
    }).catch(() => {
      if (sequence === entitiesRequest.current) setEntities(null)
    })
  }, [id])

  const handleNoteEvent = (event: NoteEvent) => {
    void loadVault()
    if (event.type === 'notes.reindexed') return
    if (event.type === 'note.deleted') {
      setOpenTabs((current) => current.filter((tabId) => tabId !== event.id))
      setDocuments((current) => {
        const next = { ...current }
        delete next[event.id]
        return next
      })
      if (activeIdRef.current === event.id) navigate('/notes')
      return
    }
    if (activeIdRef.current === event.id) void loadDocument(event.id)
  }
  useNotesSocket(handleNoteEvent)

  const tree = useMemo(() => buildNoteTree(folders, notes), [folders, notes])
  const activeDocument = id ? documents[id] : undefined
  const tabEntries = openTabs.map((tabId) => documents[tabId]).filter(Boolean)

  const openNote = (noteId: string) => {
    setOpenTabs((current) => current.includes(noteId) ? current : [...current, noteId])
    navigate(`/notes/${noteId}`)
  }

  const closeTab = (noteId: string, force = false) => {
    const doc = documentsRef.current[noteId]
    if (!force && doc?.dirty && !confirm(`「${doc.title}」还有未保存修改，确定关闭？`)) return
    const index = openTabs.indexOf(noteId)
    const nextTabs = openTabs.filter((tabId) => tabId !== noteId)
    setOpenTabs(nextTabs)
    setDocuments((current) => {
      const next = { ...current }
      delete next[noteId]
      return next
    })
    if (activeIdRef.current === noteId) {
      const nextId = nextTabs[index] || nextTabs[index - 1]
      navigate(nextId ? `/notes/${nextId}` : '/notes')
    }
  }

  const createNote = async () => {
    const title = window.prompt('新建笔记标题')?.trim()
    if (!title) return
    try {
      const created = await api.notes.create({ title, folder: selectedFolder || '' })
      await loadVault()
      openNote(created.id)
    } catch (error: any) {
      setVaultError(error.message || '新建笔记失败')
    }
  }

  const createFolder = async () => {
    const name = window.prompt(selectedFolder ? `在「${selectedFolder}」下新建文件夹` : '新建文件夹')?.trim().replace(/\\/g, '/')
    if (!name) return
    const path = selectedFolder && !name.includes('/') ? `${selectedFolder}/${name}` : name
    try {
      await api.notes.createFolder(path)
      setSelectedFolder(path)
      setExpandedFolders((current) => new Set(current).add(path))
      await loadVault()
    } catch (error: any) {
      setVaultError(error.message || '新建文件夹失败')
    }
  }

  const removeFolder = async (path: string) => {
    if (!confirm(`删除空文件夹「${path}」？文件夹不为空时不会删除。`)) return
    try {
      await api.notes.removeFolder(path)
      setSelectedFolder((current) => current === path || current?.startsWith(`${path}/`) ? path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null : current)
      setExpandedFolders((current) => {
        const next = new Set(current)
        for (const item of next) if (item === path || item.startsWith(`${path}/`)) next.delete(item)
        return next
      })
      await loadVault()
    } catch (error: any) {
      setVaultError(error.message || '删除文件夹失败')
    }
  }

  const saveDocument = async (noteId: string) => {
    const doc = documentsRef.current[noteId]
    if (!doc || !doc.dirty || doc.saving) return
    updateDocument(noteId, { saving: true, error: '' })
    try {
      const result = await api.notes.update(noteId, { content: doc.content, revision: doc.note.revision })
      updateDocument(noteId, {
        note: { ...doc.note, content: doc.content, revision: result.revision },
        dirty: false,
        saving: false,
        conflict: null,
      })
      await loadVault()
    } catch (error: any) {
      if (error instanceof ApiError && error.status === 409) {
        const server = await api.notes.get(noteId).catch(() => null)
        updateDocument(noteId, {
          saving: false,
          conflict: server ? { serverContent: server.content, serverRevision: server.revision } : null,
          error: '版本冲突：服务器内容已更新，请选择处理方式',
        })
      } else {
        updateDocument(noteId, { saving: false, error: error.message || '保存失败' })
      }
    }
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's' || !id) return
      event.preventDefault()
      void saveDocument(id)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [id])

  const overwriteServer = async (noteId: string) => {
    const doc = documentsRef.current[noteId]
    if (!doc?.conflict) return
    try {
      const result = await api.notes.update(noteId, { content: doc.content, revision: doc.conflict.serverRevision })
      updateDocument(noteId, {
        note: { ...doc.note, content: doc.content, revision: result.revision },
        dirty: false,
        conflict: null,
        error: '',
      })
    } catch (error: any) {
      updateDocument(noteId, { error: `覆盖失败：${error.message}` })
    }
  }

  const discardLocal = (noteId: string) => {
    const doc = documentsRef.current[noteId]
    if (!doc?.conflict || !confirm('将丢弃本地修改并加载服务器版本，确定？')) return
    updateDocument(noteId, {
      content: doc.conflict.serverContent,
      note: { ...doc.note, content: doc.conflict.serverContent, revision: doc.conflict.serverRevision },
      dirty: false,
      conflict: null,
      error: '',
    })
  }

  const renameDocument = async (noteId: string) => {
    const doc = documentsRef.current[noteId]
    if (!doc || !doc.title.trim() || doc.title.trim() === doc.note.title) return
    try {
      const result = await api.notes.rename(noteId, { title: doc.title.trim() })
      updateDocument(noteId, { note: { ...doc.note, title: result.title, path: result.path, revision: result.revision }, title: result.title })
      await loadVault()
    } catch (error: any) {
      updateDocument(noteId, { title: doc.note.title, error: `重命名失败：${error.message}` })
    }
  }

  const moveDocument = async (noteId: string, folder: string) => {
    const doc = documentsRef.current[noteId]
    if (!doc || folder === folderFromPath(doc.note.path)) return
    try {
      const result = await api.notes.rename(noteId, { folder })
      updateDocument(noteId, { note: { ...doc.note, path: result.path, revision: result.revision } })
      await loadVault()
    } catch (error: any) {
      updateDocument(noteId, { error: `移动失败：${error.message}` })
    }
  }

  const removeDocument = async (noteId: string) => {
    const doc = documentsRef.current[noteId]
    if (!doc || !confirm(`确定删除笔记「${doc.title}」？其它文件中的引用不会删除。`)) return
    try {
      await api.notes.remove(noteId)
      closeTab(noteId, true)
      await loadVault()
    } catch (error: any) {
      updateDocument(noteId, { error: `删除失败：${error.message}` })
    }
  }

  const runTool = (action: (view: EditorView) => void) => {
    if (editorRef.current) action(editorRef.current)
  }

  const goEntity = (entity: { type: EntityLinkType; entityKey: string }) => {
    if (entity.type === 'tag') navigate('/tags')
    else if (entity.type === 'todo') navigate('/todos')
    else if (entity.type === 'date') navigate(`/calendar?date=${entity.entityKey}`)
    else navigate('/')
  }

  const markdownTools = [
    { label: 'H', title: '标题', action: () => runTool((view) => cmPrefixLines(view, '## ')) },
    { label: 'B', title: '粗体', action: () => runTool((view) => cmInsertAround(view, '**', '**', '粗体文字')) },
    { label: 'I', title: '斜体', action: () => runTool((view) => cmInsertAround(view, '*', '*', '斜体文字')) },
    { label: 'S', title: '删除线', action: () => runTool((view) => cmInsertAround(view, '~~', '~~', '删除文字')) },
    { label: '•', title: '无序列表', action: () => runTool((view) => cmPrefixLines(view, '- ')) },
    { label: '☐', title: '任务列表', action: () => runTool((view) => cmPrefixLines(view, '- [ ] ')) },
    { label: '❯', title: '引用', action: () => runTool((view) => cmPrefixLines(view, '> ')) },
    { label: '<>', title: '行内代码', action: () => runTool((view) => cmInsertAround(view, '`', '`', '代码')) },
    { label: '↗', title: '插入链接', action: () => runTool((view) => cmInsertAround(view, '[', '](https://)', '链接文字')) },
    { label: '```', title: '代码块', action: () => runTool((view) => cmInsertAround(view, '```\n', '\n```', '代码')) },
  ]

  return (
    <div className="vault-page">
      <div className="flex h-[calc(100vh-7rem)] max-h-[calc(100vh-7rem)] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900">
        <div className="flex w-10 shrink-0 flex-col items-center gap-2 border-r border-gray-200 bg-gray-50 py-2 dark:border-gray-800 dark:bg-gray-950">
          <button type="button" onClick={() => setSidebarOpen((open) => !open)} className="flex h-8 w-8 items-center justify-center rounded-md text-sm text-gray-500 hover:bg-gray-200 hover:text-brand dark:hover:bg-gray-800" title={sidebarOpen ? '隐藏文件树' : '显示文件树'} aria-label={sidebarOpen ? '隐藏文件树' : '显示文件树'}>
            {sidebarOpen ? '◧' : '▣'}
          </button>
          <button type="button" onClick={createNote} className="flex h-8 w-8 items-center justify-center rounded-md text-lg text-gray-500 hover:bg-gray-200 hover:text-brand dark:hover:bg-gray-800" title="新建笔记" aria-label="新建笔记">＋</button>
          <button type="button" onClick={createFolder} className="flex h-8 w-8 items-center justify-center rounded-md text-sm text-gray-500 hover:bg-gray-200 hover:text-brand dark:hover:bg-gray-800" title="新建文件夹" aria-label="新建文件夹">📁</button>
        </div>

        {sidebarOpen && (
          <aside className="flex w-64 shrink-0 flex-col border-r border-gray-200 dark:border-gray-800">
            <div className="border-b border-gray-100 p-3 dark:border-gray-800">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">笔记库</span>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => void openVaultSettings()} className="text-xs text-gray-400 hover:text-brand" title="设置文件库" aria-label="设置文件库">⚙</button>
                  <button type="button" onClick={() => void loadVault()} className="text-xs text-gray-400 hover:text-brand" title="刷新">↻</button>
                </div>
              </div>
              <div className="mb-2 truncate text-[10px] text-gray-400" title={vaultPath}>{vaultPath || '正在读取文件库…'}</div>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索笔记" className="input !py-1.5 !text-xs" />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              <VaultTreeNode
                node={tree}
                expandedFolders={expandedFolders}
                selectedFolder={selectedFolder}
                onToggle={(path) => setExpandedFolders((current) => { const next = new Set(current); next.has(path) ? next.delete(path) : next.add(path); return next })}
                onSelectFolder={setSelectedFolder}
                onOpenNote={openNote}
                onDeleteFolder={(path) => void removeFolder(path)}
              />
            </div>
          </aside>
        )}

        <section ref={contentScrollRef} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
          <div className="flex min-h-11 shrink-0 items-center gap-1 overflow-x-auto border-b border-gray-200 bg-gray-50/70 px-2 dark:border-gray-800 dark:bg-gray-950/50">
            {tabEntries.length === 0 && <span className="px-2 text-xs text-gray-400">选择一篇笔记开始</span>}
            {tabEntries.map((doc) => (
              <div key={doc.note.id} className={`group flex max-w-52 shrink-0 items-center gap-1 rounded-t-md border border-b-0 px-2 py-2 text-xs ${id === doc.note.id ? 'border-gray-200 bg-white text-brand dark:border-gray-800 dark:bg-gray-900' : 'border-transparent text-gray-500 hover:bg-white/70 dark:hover:bg-gray-900/70'}`}>
                <button type="button" onClick={() => openNote(doc.note.id)} className="min-w-0 flex-1 truncate text-left" title={doc.note.path}>{doc.dirty ? '● ' : ''}{doc.title || shortName(doc.note.path)}</button>
                <button type="button" onClick={() => closeTab(doc.note.id)} className="rounded px-1 text-gray-400 hover:bg-gray-200 hover:text-gray-700 dark:hover:bg-gray-800" aria-label={`关闭 ${doc.title}`}>×</button>
              </div>
            ))}
          </div>

          {vaultError && <div className="mx-3 mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-900/20 dark:text-red-300">{vaultError}</div>}

          {!activeDocument ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center text-gray-400">
              <div className="text-5xl opacity-60">🗂</div>
              <div>
                <div className="text-base font-semibold text-gray-600 dark:text-gray-300">打开一篇笔记</div>
                <div className="mt-1 text-xs">从左侧文件树选择 Markdown 文件，或新建一篇笔记。</div>
              </div>
              <button type="button" onClick={createNote} className="rounded-lg bg-brand px-3 py-1.5 text-sm text-white hover:bg-brand-600">新建笔记</button>
            </div>
          ) : (
            <VaultEditor
              document={activeDocument}
              folders={folders}
              mode={viewMode}
              editorRef={editorRef}
              markdownTools={markdownTools}
              onChange={(content) => updateDocument(activeDocument.note.id, { content, dirty: true, error: '' })}
              onTitleChange={(title) => updateDocument(activeDocument.note.id, { title })}
              onTitleBlur={() => void renameDocument(activeDocument.note.id)}
              onFolderChange={(folder) => void moveDocument(activeDocument.note.id, folder)}
              onModeChange={setViewMode}
              onSave={() => void saveDocument(activeDocument.note.id)}
              onDelete={() => void removeDocument(activeDocument.note.id)}
              onOverwrite={() => void overwriteServer(activeDocument.note.id)}
              onDiscard={() => discardLocal(activeDocument.note.id)}
              entities={entities}
              onGoEntity={goEntity}
              navigate={navigate}
              scrollContainerRef={contentScrollRef}
            />
          )}
        </section>
      </div>
      {vaultSettingsOpen && <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/30 p-4" role="dialog" aria-modal="true" aria-labelledby="vault-settings-title">
        <div className="w-full max-w-lg rounded-xl bg-white p-4 shadow-xl dark:bg-gray-900">
          <div className="mb-3 flex items-center justify-between">
            <h2 id="vault-settings-title" className="text-base font-semibold text-gray-800 dark:text-gray-100">设置笔记文件库</h2>
            <button type="button" onClick={() => setVaultSettingsOpen(false)} className="rounded px-2 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800" aria-label="关闭">×</button>
          </div>
          <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">填写 TagTime 与 Obsidian 共同使用的本机 Vault 文件夹路径，例如 <code>F:/Obsidian/MyVault</code>。</p>
          {vaultSource === 'environment' && <p className="mb-2 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-700 dark:bg-amber-900/20 dark:text-amber-200">当前路径由 NOTES_DIR 启动配置固定，请修改启动配置后重启服务。</p>}
          <input value={vaultPathDraft} onChange={(event) => setVaultPathDraft(event.target.value)} disabled={vaultSource === 'environment'} className="input w-full font-mono text-xs disabled:cursor-not-allowed disabled:opacity-60" placeholder="F:/Obsidian/MyVault" autoFocus />
          <p className="mt-2 text-[11px] text-gray-400">只会重新建立索引，不会复制、移动或删除 Markdown 文件。</p>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => setVaultSettingsOpen(false)} className="rounded-md border border-gray-200 px-3 py-1.5 text-xs text-gray-600 dark:border-gray-700 dark:text-gray-300">取消</button>
            <button type="button" onClick={() => void switchVault()} disabled={vaultBusy || vaultSource === 'environment' || !vaultPathDraft.trim()} className="rounded-md bg-brand px-3 py-1.5 text-xs text-white disabled:opacity-40">{vaultBusy ? '切换中…' : '保存并切换'}</button>
          </div>
        </div>
      </div>}
    </div>
  )
}

function VaultTreeNode({
  node,
  expandedFolders,
  selectedFolder,
  onToggle,
  onSelectFolder,
  onOpenNote,
  onDeleteFolder,
}: {
  node: NoteFolderNode
  expandedFolders: Set<string>
  selectedFolder: string | null
  onToggle: (path: string) => void
  onSelectFolder: (path: string) => void
  onOpenNote: (id: string) => void
  onDeleteFolder: (path: string) => void
}) {
  return (
    <div className="space-y-0.5">
      {node.notes.map((note) => (
        <button key={note.id} type="button" onClick={() => onOpenNote(note.id)} className="flex h-8 w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-left text-sm text-gray-600 hover:bg-gray-100 hover:text-brand dark:text-gray-300 dark:hover:bg-gray-800" title={note.path}>
          <span className="w-4 shrink-0 text-center text-xs text-gray-400">▱</span>
          <span className="truncate">{note.title || shortName(note.path)}</span>
        </button>
      ))}
      {node.children.map((child) => {
        const expanded = expandedFolders.has(child.path)
        const count = child.notes.length + child.children.reduce((total, item) => total + item.notes.length + item.children.length, 0)
        return (
          <div key={child.path}>
            <div className={`group flex items-center rounded-md text-sm ${selectedFolder === child.path ? 'bg-brand/10 text-brand' : 'text-gray-600 dark:text-gray-300'}`}>
              <button type="button" onClick={() => onToggle(child.path)} className="flex h-8 w-7 shrink-0 items-center justify-center text-xs text-gray-400 hover:text-brand" aria-label={expanded ? `收起 ${child.name}` : `展开 ${child.name}`}>{expanded ? '⌄' : '›'}</button>
              <button type="button" onClick={() => onSelectFolder(child.path)} className="flex h-8 min-w-0 flex-1 items-center gap-1.5 text-left hover:text-brand" title={child.path}>
                <span className="text-xs">{expanded ? '📂' : '📁'}</span>
                <span className="truncate">{child.name}</span>
                {count > 0 && <span className="ml-auto pr-2 text-[10px] text-gray-400">{count}</span>}
              </button>
              <button type="button" onClick={(event) => { event.stopPropagation(); onDeleteFolder(child.path) }} className={`mr-1 rounded px-1 text-[11px] text-gray-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-900/20 ${selectedFolder === child.path ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'}`} title="删除空文件夹" aria-label={`删除文件夹 ${child.name}`}>×</button>
            </div>
            {expanded && <div className="ml-3 border-l border-gray-100 pl-1 dark:border-gray-800"><VaultTreeNode node={child} expandedFolders={expandedFolders} selectedFolder={selectedFolder} onToggle={onToggle} onSelectFolder={onSelectFolder} onOpenNote={onOpenNote} onDeleteFolder={onDeleteFolder} /></div>}
          </div>
        )
      })}
    </div>
  )
}

function VaultEditor({
  document,
  folders,
  mode,
  editorRef,
  markdownTools,
  onChange,
  onTitleChange,
  onTitleBlur,
  onFolderChange,
  onModeChange,
  onSave,
  onDelete,
  onOverwrite,
  onDiscard,
  entities,
  onGoEntity,
  navigate,
  scrollContainerRef,
}: {
  document: VaultDocument
  folders: string[]
  mode: ViewMode
  editorRef: MutableRefObject<EditorView | null>
  markdownTools: Array<{ label: string; title: string; action: () => void }>
  onChange: (content: string) => void
  onTitleChange: (title: string) => void
  onTitleBlur: () => void
  onFolderChange: (folder: string) => void
  onModeChange: (mode: ViewMode) => void
  onSave: () => void
  onDelete: () => void
  onOverwrite: () => void
  onDiscard: () => void
  entities: RelatedEntities | null
  onGoEntity: (entity: { type: EntityLinkType; entityKey: string }) => void
  navigate: (to: string) => void
  scrollContainerRef: MutableRefObject<HTMLElement | null>
}) {
  const { note, title, content, dirty, saving, error, conflict } = document
  const [compactHeader, setCompactHeader] = useState(false)
  const preview = useMemo(() => renderMarkdown(content), [content])
  useEffect(() => {
    const node = scrollContainerRef.current
    if (!node) return
    const update = () => setCompactHeader(node.scrollTop > 24)
    update()
    node.addEventListener('scroll', update, { passive: true })
    return () => node.removeEventListener('scroll', update)
  }, [scrollContainerRef])
  const atomicExtensions = useMemo(() => [
    atomicMathPreview,
    wikiLinks({
      suggest: async (query) => (await api.notes.autocomplete(query)).map((entry) => ({ target: entry.title, label: entry.title, detail: entry.path })),
      resolve: async (target) => {
        if (isEntityTarget(target)) return null
        const entries = await api.notes.autocomplete(target)
        const match = entries.find((entry) => entry.title === target)
        return match ? { target, label: match.title, status: 'resolved' as const } : { target, label: target, status: 'missing' as const }
      },
      shouldResolve: (target) => !isEntityTarget(target),
      onOpen: (target) => {
        if (isEntityTarget(target)) return
        void api.notes.autocomplete(target).then((entries) => {
          const match = entries.find((entry) => entry.title === target) || entries[0]
          if (match) navigate(`/notes/${match.id}`)
        })
      },
    }),
  ], [navigate])
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={`sticky top-0 z-10 border-b border-gray-200 bg-white/95 backdrop-blur transition-[padding] duration-150 dark:border-gray-800 dark:bg-gray-900/95 ${compactHeader ? 'px-3 py-1' : 'px-3 py-2'}`}>
        <div className="flex items-center gap-2">
          <input value={title} onChange={(event) => onTitleChange(event.target.value)} onBlur={onTitleBlur} className={`min-w-0 flex-1 bg-transparent font-bold text-gray-900 transition-[font-size] duration-150 focus:outline-none dark:text-gray-50 ${compactHeader ? 'text-sm' : 'text-lg'}`} aria-label="笔记标题" />
          <span className={`shrink-0 text-xs ${dirty ? 'text-amber-500' : 'text-gray-400'}`}>{dirty ? '● 未保存' : '已保存'}</span>
          <button type="button" onClick={onDelete} className={`rounded-md border border-red-200 text-red-500 hover:bg-red-50 dark:border-red-900 dark:hover:bg-red-900/20 ${compactHeader ? 'px-1.5 py-0.5 text-[11px]' : 'px-2 py-1 text-xs'}`}>删除</button>
          <button type="button" onClick={onSave} disabled={!dirty || saving} className={`rounded-md bg-brand text-white disabled:opacity-40 ${compactHeader ? 'px-2 py-0.5 text-xs' : 'px-3 py-1 text-sm'}`}>{saving ? '保存中…' : '保存'}</button>
        </div>
        <div className={`flex flex-wrap items-center justify-between gap-2 text-xs text-gray-400 ${compactHeader ? 'mt-0.5' : 'mt-1'}`}>
          <div className="flex min-w-0 items-center gap-2">
            <select value={folderFromPath(note.path)} onChange={(event) => onFolderChange(event.target.value)} className="max-w-52 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs dark:border-gray-800 dark:bg-gray-900" title="移动到文件夹">
              <option value="">根目录</option>
              {folders.map((folder) => <option key={folder} value={folder}>{folder}</option>)}
            </select>
            <span className="truncate">{note.path} · rev {note.revision}</span>
          </div>
          <div className="flex gap-1" role="group" aria-label="笔记视图">
            {(['live', 'edit', 'split', 'preview'] as const).map((value) => <button key={value} type="button" onClick={() => onModeChange(value)} className={`rounded-md px-2 py-1 text-[11px] ${mode === value ? 'bg-brand text-white' : 'bg-gray-100 text-gray-500 dark:bg-gray-800'}`}>{value === 'live' ? '实时' : value === 'edit' ? '源码' : value === 'split' ? '分屏' : '阅读'}</button>)}
          </div>
        </div>
      </div>

      {error && <div className="mx-3 mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-900/20 dark:text-red-300">{error}</div>}
      {conflict && <div className="mx-3 mt-2 space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-700 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
        <div>服务器版本已更新到 rev {conflict.serverRevision}，本地修改尚未保存。</div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={onOverwrite} className="rounded-md bg-brand px-2 py-1 text-white">覆盖服务器</button>
          <button type="button" onClick={onDiscard} className="rounded-md border border-amber-300 px-2 py-1 dark:border-amber-700">丢弃本地修改</button>
          <details className="basis-full"><summary className="cursor-pointer">查看服务器版本</summary><textarea readOnly value={conflict.serverContent} className="mt-1 h-24 w-full rounded border border-amber-200 bg-white p-2 font-mono text-xs dark:border-amber-800 dark:bg-gray-900" /></details>
        </div>
      </div>}

      {mode !== 'preview' && mode !== 'live' && <div className="flex min-h-9 items-center gap-1 overflow-x-auto border-b border-gray-200 px-3 py-1 dark:border-gray-800" role="toolbar" aria-label="Markdown 格式">
        {markdownTools.map((tool) => <button key={tool.title} type="button" title={tool.title} aria-label={tool.title} onMouseDown={(event) => event.preventDefault()} onClick={tool.action} className={`h-7 min-w-8 shrink-0 rounded-md px-2 text-xs text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800 ${tool.label === 'B' ? 'font-bold' : tool.label === 'I' ? 'italic' : ''}`}>{tool.label}</button>)}
      </div>}

      <div className={`min-h-0 flex-1 p-3 ${mode === 'split' ? 'grid grid-cols-1 gap-3 md:grid-cols-2' : ''}`}>
        {mode === 'live' && <div className="min-h-[55vh] overflow-hidden rounded-lg border border-gray-200 bg-white px-3 py-2 dark:border-gray-800 dark:bg-gray-900"><AtomicCodeMirrorEditor documentId={`${note.id}:${note.revision}`} markdownSource={content} onMarkdownChange={onChange} extensions={atomicExtensions} /></div>}
        {mode === 'edit' && <div className="min-h-[55vh] overflow-hidden rounded-lg border border-gray-200 bg-white px-3 py-2 dark:border-gray-800 dark:bg-gray-900"><MarkdownEditor key={note.id} value={content} mode="source" editorRef={editorRef} onChange={onChange} autoFocus={false} /></div>}
        {mode === 'split' && <div className="min-h-[55vh] overflow-hidden rounded-lg border border-gray-200 bg-white px-3 py-2 dark:border-gray-800 dark:bg-gray-900"><MarkdownEditor key={note.id} value={content} mode="source" editorRef={editorRef} onChange={onChange} autoFocus={false} /></div>}
        {(mode === 'split' || mode === 'preview') && <div className="prose-preview min-h-[55vh] overflow-auto rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm text-gray-800 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-100" dangerouslySetInnerHTML={{ __html: preview }} />}
      </div>

      <div className="grid grid-cols-1 gap-3 border-t border-gray-200 p-3 text-xs dark:border-gray-800 xl:grid-cols-2">
        <LinkGroup title={`出链 (${note.outLinks.length})`} items={note.outLinks.map((link) => ({ id: link.targetNoteId, label: link.linkText || link.targetTitle }))} navigate={navigate} />
        <LinkGroup title={`反向链接 (${note.inLinks.length})`} items={note.inLinks.map((link) => ({ id: link.sourceNoteId, label: link.sourceTitle }))} navigate={navigate} />
      </div>
      {entities && <div className="border-t border-gray-200 px-3 pb-3 pt-2 text-xs dark:border-gray-800">
        <div className="mb-1 font-semibold text-gray-500 dark:text-gray-400">关联的 TagTime</div>
        <div className="flex flex-wrap gap-1.5">
          {(['tags', 'todos', 'dates', 'memos'] as const).flatMap((key) => entities[key]).map((entity) => entity.resolved ? (
            <button key={`${entity.type}:${entity.entityKey}`} type="button" onClick={() => onGoEntity(entity)} className="rounded bg-brand/10 px-1.5 py-0.5 text-brand hover:bg-brand/20">{entity.linkText || entity.name || entity.entityKey}</button>
          ) : (
            <span key={`${entity.type}:${entity.entityKey}`} className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-400 line-through dark:bg-gray-800">{entity.linkText || entity.entityKey}</span>
          ))}
          {(['tags', 'todos', 'dates', 'memos'] as const).every((key) => entities[key].length === 0) && <span className="text-gray-400">暂无关联</span>}
        </div>
      </div>}
    </div>
  )
}

function LinkGroup({ title, items, navigate }: { title: string; items: Array<{ id: string | null; label: string }>; navigate: (to: string) => void }) {
  return <div><div className="mb-1 font-semibold text-gray-500 dark:text-gray-400">{title}</div>{items.length === 0 ? <div className="text-gray-400">暂无</div> : <div className="flex flex-wrap gap-x-3 gap-y-1">{items.map((item, index) => item.id ? <button key={`${item.id}-${index}`} type="button" onClick={() => navigate(`/notes/${item.id}`)} className="text-brand hover:underline">{item.label}</button> : <span key={`${item.label}-${index}`} className="text-gray-400 line-through">{item.label}</span>)}</div>}</div>
}
