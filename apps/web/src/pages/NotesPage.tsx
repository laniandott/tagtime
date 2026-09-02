import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useNotesSocket } from '../hooks/useNotesSocket'
import type { NoteListEntry } from '../types'

function noteFolder(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}

function folderName(path: string): string {
  return path.split('/').pop() || '根目录'
}

interface NoteFolderNode {
  path: string
  name: string
  children: NoteFolderNode[]
  notes: NoteListEntry[]
}

function buildNoteTree(folders: string[], notes: NoteListEntry[]): NoteFolderNode {
  const nodes = new Map<string, NoteFolderNode>()

  const ensure = (rawPath: string): NoteFolderNode => {
    const path = rawPath.split('/').filter(Boolean).join('/')
    const existing = nodes.get(path)
    if (existing) return existing

    const node: NoteFolderNode = { path, name: folderName(path), children: [], notes: [] }
    nodes.set(path, node)
    if (path) {
      const parentPath = path.slice(0, path.lastIndexOf('/'))
      ensure(parentPath).children.push(node)
    }
    return node
  }

  ensure('')
  folders.forEach((folder) => ensure(folder))
  notes.forEach((note) => ensure(noteFolder(note.path)).notes.push(note))

  const sort = (node: NoteFolderNode) => {
    node.children.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    node.notes.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    node.children.forEach(sort)
  }
  const root = nodes.get('')!
  sort(root)
  return root
}

function noteCount(node: NoteFolderNode): number {
  return node.notes.length + node.children.reduce((total, child) => total + noteCount(child), 0)
}

export default function NotesPage() {
  const navigate = useNavigate()
  const [notes, setNotes] = useState<NoteListEntry[]>([])
  const [folders, setFolders] = useState<string[]>([])
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newNoteFolder, setNewNoteFolder] = useState('')
  const [showNewFolder, setShowNewFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [expandedFolders, setExpandedFolders] = useState<Set<string> | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const loadSequence = useRef(0)

  const load = async () => {
    const sequence = ++loadSequence.current
    try {
      const [nextNotes, folderResult] = await Promise.all([
        api.notes.list(q || undefined),
        api.notes.folders(),
      ])
      if (sequence !== loadSequence.current) return
      setNotes(nextNotes)
      setFolders(folderResult.folders)
      setError('')
    } catch (e: any) {
      if (sequence !== loadSequence.current) return
      setError(e.message)
    }
  }

  useEffect(() => { void load() }, [q])
  useNotesSocket(() => { void load() })

  const visibleNotes = useMemo(() => {
    if (selectedFolder === null) return notes
    if (selectedFolder === '') return notes.filter((note) => noteFolder(note.path) === '')
    return notes.filter((note) => {
      const folder = noteFolder(note.path)
      return folder === selectedFolder || folder.startsWith(`${selectedFolder}/`)
    })
  }, [notes, selectedFolder])

  const noteTree = useMemo(() => buildNoteTree(folders, notes), [folders, notes])
  const openFolders = expandedFolders ?? new Set(folders)

  const openNewNote = () => {
    setNewNoteFolder(selectedFolder ?? '')
    setShowNew(true)
    setShowNewFolder(false)
  }

  const createNew = async () => {
    if (!newTitle.trim() || busy) return
    setBusy(true)
    try {
      const created = await api.notes.create({ title: newTitle.trim(), folder: newNoteFolder })
      setNewTitle('')
      setShowNew(false)
      navigate(`/notes/${created.id}`)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const createFolder = async () => {
    const entered = newFolderName.trim().replace(/\\/g, '/')
    if (!entered || busy) return
    const parent = selectedFolder && !entered.includes('/') ? `${selectedFolder}/` : ''
    setBusy(true)
    try {
      const created = await api.notes.createFolder(`${parent}${entered}`)
      setNewFolderName('')
      setShowNewFolder(false)
      setSelectedFolder(created.path)
      await load()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const removeSelectedFolder = async () => {
    if (!selectedFolder) return
    if (!confirm(`删除空文件夹「${selectedFolder}」？`)) return
    try {
      await api.notes.removeFolder(selectedFolder)
      const parentIndex = selectedFolder.lastIndexOf('/')
      setSelectedFolder(parentIndex === -1 ? '' : selectedFolder.slice(0, parentIndex))
      await load()
    } catch (e: any) {
      setError(e.message)
    }
  }

  const toggleFolder = (path: string) => {
    setExpandedFolders((current) => {
      const next = new Set(current ?? folders)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const selectFolder = (path: string) => {
    setSelectedFolder(path)
    setExpandedFolders((current) => {
      const next = new Set(current ?? folders)
      for (let index = path.lastIndexOf('/'); index >= 0; index = path.lastIndexOf('/', index - 1)) {
        next.add(path.slice(0, index))
      }
      if (path) next.add(path)
      return next
    })
  }

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-bold text-gray-800 dark:text-gray-100">笔记</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate('/notes/graph')}
            className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          >
            关系图
          </button>
          <button
            onClick={() => { setShowNewFolder((value) => !value); setShowNew(false) }}
            className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          >
            新建文件夹
          </button>
          <button
            onClick={openNewNote}
            className="px-3 py-1.5 text-sm bg-brand text-white rounded-lg hover:bg-brand-600 transition-colors"
          >
            新建笔记
          </button>
        </div>
      </div>

      {error && <div className="text-sm text-red-500">{error}</div>}

      {showNewFolder && (
        <div className="flex gap-2">
          <input
            autoFocus
            value={newFolderName}
            onChange={(event) => setNewFolderName(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void createFolder() }}
            placeholder={selectedFolder ? `在 ${selectedFolder} 下新建文件夹` : '文件夹名称，也可输入 工作/项目'}
            className="flex-1 input"
          />
          <button onClick={createFolder} disabled={busy || !newFolderName.trim()} className="px-4 py-2 text-sm bg-brand text-white rounded-lg disabled:opacity-50">
            创建
          </button>
        </div>
      )}

      {showNew && (
        <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_220px_auto] gap-2">
          <input
            autoFocus
            value={newTitle}
            onChange={(event) => setNewTitle(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void createNew() }}
            placeholder="笔记标题"
            className="input"
          />
          <select value={newNoteFolder} onChange={(event) => setNewNoteFolder(event.target.value)} className="input">
            <option value="">根目录</option>
            {folders.map((folder) => <option key={folder} value={folder}>{folder}</option>)}
          </select>
          <button onClick={createNew} disabled={busy || !newTitle.trim()} className="px-4 py-2 text-sm bg-brand text-white rounded-lg disabled:opacity-50">
            创建
          </button>
        </div>
      )}

      <input ref={searchInputRef} value={q} onChange={(event) => setQ(event.target.value)} placeholder="搜索标题或路径" className="w-full input" />

      <div className="flex min-h-[480px] overflow-hidden rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
        <div className="flex w-10 shrink-0 flex-col items-center gap-1 border-r border-gray-200 bg-gray-50 py-2 dark:border-gray-800 dark:bg-gray-950">
          <button
            type="button"
            onClick={() => setSidebarOpen((open) => !open)}
            className="flex h-8 w-8 items-center justify-center rounded-md text-sm text-gray-500 hover:bg-gray-200 hover:text-brand dark:hover:bg-gray-800"
            title={sidebarOpen ? '隐藏文件夹栏' : '显示文件夹栏'}
            aria-label={sidebarOpen ? '隐藏文件夹栏' : '显示文件夹栏'}
          >
            {sidebarOpen ? '◧' : '▣'}
          </button>
          <button
            type="button"
            onClick={() => searchInputRef.current?.focus()}
            className="flex h-8 w-8 items-center justify-center rounded-md text-sm text-gray-400 hover:bg-gray-200 hover:text-brand dark:hover:bg-gray-800"
            title="搜索笔记"
            aria-label="搜索笔记"
          >
            ⌕
          </button>
        </div>

        {sidebarOpen && (
          <aside className="w-64 shrink-0 border-r border-gray-200 dark:border-gray-800">
            <div className="flex h-11 items-center justify-between border-b border-gray-100 px-3 text-sm font-semibold text-gray-700 dark:border-gray-800 dark:text-gray-200">
              <span>文件</span>
              <button
                type="button"
                onClick={() => { setShowNewFolder((value) => !value); setShowNew(false) }}
                className="rounded-md px-2 py-1 text-base font-normal text-gray-400 hover:bg-gray-100 hover:text-brand dark:hover:bg-gray-800"
                title="新建文件夹"
                aria-label="新建文件夹"
              >
                ＋
              </button>
            </div>
            <div className="max-h-[calc(100vh-300px)] overflow-y-auto p-2">
              <button
                type="button"
                onClick={() => setSelectedFolder(null)}
                className={`mb-1 flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm ${selectedFolder === null ? 'bg-brand/10 text-brand font-medium' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800'}`}
              >
                <span className="w-4 text-center text-xs">⌂</span>
                <span className="truncate">全部笔记</span>
                <span className="ml-auto text-xs text-gray-400">{notes.length}</span>
              </button>
              <button
                type="button"
                onClick={() => setSelectedFolder('')}
                className={`mb-1 flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm ${selectedFolder === '' ? 'bg-brand/10 text-brand font-medium' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800'}`}
              >
                <span className="w-4 text-center text-xs">⌄</span>
                <span className="truncate">根目录</span>
                <span className="ml-auto text-xs text-gray-400">{noteTree.notes.length}</span>
              </button>
              <NoteTreeNode
                node={noteTree}
                expandedFolders={openFolders}
                selectedFolder={selectedFolder}
                onToggleFolder={toggleFolder}
                onSelectFolder={selectFolder}
                onOpenNote={(note) => navigate(`/notes/${note.id}`)}
              />
            </div>
          {selectedFolder && (
              <button onClick={removeSelectedFolder} className="m-2 px-2 text-xs text-red-500 hover:underline">
                删除当前空文件夹
              </button>
            )}
          </aside>
        )}

        <section className="min-w-0 flex-1 p-3 md:pl-4">
          <div className="flex items-center justify-between gap-2 pb-2 text-xs text-gray-400">
            <span className="truncate">{selectedFolder === null ? '全部笔记' : selectedFolder || '根目录'}</span>
            <span>{visibleNotes.length} 篇</span>
          </div>
          {visibleNotes.length === 0 ? (
            <div className="text-center py-16 text-sm text-gray-400 dark:text-gray-500">这个位置还没有笔记。</div>
          ) : (
            <div className="divide-y divide-gray-100 dark:divide-gray-800">
              {visibleNotes.map((note) => (
                <button
                  key={note.id}
                  onClick={() => navigate(`/notes/${note.id}`)}
                  className="w-full flex items-center justify-between gap-2 px-2 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors"
                >
                  <div className="min-w-0">
                    <div className="font-medium text-gray-800 dark:text-gray-100 truncate">{note.title}</div>
                    {!sidebarOpen && <div className="text-xs text-gray-400 dark:text-gray-500 truncate">{note.path}</div>}
                  </div>
                  <div className="shrink-0 flex items-center gap-2 text-xs text-gray-400 dark:text-gray-500">
                    <span title="出链">→ {note.outLinkCount}</span>
                    <span title="反链">← {note.inLinkCount}</span>
                    <span className="tabular-nums hidden sm:inline">{new Date(note.updatedAt).toLocaleDateString('zh-CN')}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function NoteTreeNode({
  node,
  expandedFolders,
  selectedFolder,
  onToggleFolder,
  onSelectFolder,
  onOpenNote,
}: {
  node: NoteFolderNode
  expandedFolders: Set<string>
  selectedFolder: string | null
  onToggleFolder: (path: string) => void
  onSelectFolder: (path: string) => void
  onOpenNote: (note: NoteListEntry) => void
}) {
  return (
    <div className="space-y-0.5">
      {node.children.map((child) => {
        const expanded = expandedFolders.has(child.path)
        return (
          <div key={child.path}>
            <div className={`flex items-center rounded-md text-sm ${selectedFolder === child.path ? 'bg-brand/10 text-brand' : 'text-gray-600 dark:text-gray-300'}`}>
              <button
                type="button"
                onClick={() => onToggleFolder(child.path)}
                className="flex h-8 w-7 shrink-0 items-center justify-center text-xs text-gray-400 hover:text-brand"
                aria-label={expanded ? `收起文件夹 ${child.name}` : `展开文件夹 ${child.name}`}
              >
                {expanded ? '⌄' : '›'}
              </button>
              <button
                type="button"
                onClick={() => onSelectFolder(child.path)}
                className="flex h-8 min-w-0 flex-1 items-center gap-1.5 text-left hover:text-brand"
                title={child.path}
              >
                <span className="text-xs">{expanded ? '📂' : '📁'}</span>
                <span className="truncate">{child.name}</span>
                <span className="ml-auto pr-2 text-xs text-gray-400">{noteCount(child)}</span>
              </button>
            </div>
            {expanded && (
              <div className="ml-3 border-l border-gray-100 pl-1 dark:border-gray-800">
                <NoteTreeNode
                  node={child}
                  expandedFolders={expandedFolders}
                  selectedFolder={selectedFolder}
                  onToggleFolder={onToggleFolder}
                  onSelectFolder={onSelectFolder}
                  onOpenNote={onOpenNote}
                />
              </div>
            )}
          </div>
        )
      })}

      {node.notes.map((note) => (
        <button
          key={note.id}
          type="button"
          onClick={() => onOpenNote(note)}
          className="flex h-8 w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-left text-sm text-gray-600 hover:bg-gray-100 hover:text-brand dark:text-gray-300 dark:hover:bg-gray-800"
          title={note.path}
        >
          <span className="w-4 shrink-0 text-center text-xs text-gray-400">▱</span>
          <span className="truncate">{note.title || note.path}</span>
        </button>
      ))}
    </div>
  )
}
