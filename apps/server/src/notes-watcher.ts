import chokidar, { type FSWatcher } from 'chokidar'
import { sep } from 'node:path'
import { NOTES_DIR } from './config.js'
import { syncNoteFile, removeNoteByPath } from './notes.js'

let watcher: FSWatcher | null = null

// 按相对路径去抖动，避免同一文件短时间内重复处理
function makeFileDebounce(fn: (relPath: string) => void, ms: number) {
  const timers = new Map<string, NodeJS.Timeout>()
  return (relPath: string) => {
    const prev = timers.get(relPath)
    if (prev) clearTimeout(prev)
    timers.set(relPath, setTimeout(() => { timers.delete(relPath); fn(relPath) }, ms))
  }
}

function relOf(absPath: string): string {
  return absPath.replace(NOTES_DIR + sep, '').replace(/\\/g, '/')
}

export function trackNotesDirectory() {
  if (watcher) return watcher
  watcher = chokidar.watch(NOTES_DIR, {
    ignoreInitial: true,
    ignored: (p: string) => {
      const name = p.split(/[\\/]/).pop() || ''
      return name.endsWith('.tmp') || name.endsWith('.bak') || name === 'assets'
    },
    awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
  })

  const debouncedSync = makeFileDebounce((rel: string) => void syncNoteFile(rel, 'watcher'), 500)

  watcher.on('all', (event, absPath) => {
    if (!absPath.endsWith('.md')) return
    const rel = relOf(absPath)
    if (event === 'unlink' || event === 'unlinkDir') {
      void removeNoteByPath(rel)
    } else if (event === 'add' || event === 'change') {
      debouncedSync(rel)
    }
  })
  return watcher
}