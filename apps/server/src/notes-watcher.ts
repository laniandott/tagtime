import chokidar, { type FSWatcher } from 'chokidar'
import { sep } from 'node:path'
import { NOTES_DIR } from './config.js'
import { syncNoteFile, removeNoteByPath, isWatcherPathSuspended } from './notes.js'

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

  const debouncedSync = makeFileDebounce((rel: string) => {
    // 到执行时刻仍处于暂停期（如 API 重命名）则丢弃，避免给新路径建重复索引
    if (isWatcherPathSuspended(rel)) return
    void syncNoteFile(rel, 'watcher')
  }, 500)

  watcher.on('all', (event, absPath) => {
    if (!absPath.endsWith('.md')) return
    const rel = relOf(absPath)
    // 第一版仅支持 notes/ 根目录单层，子目录文件与启动扫描保持一致，一律忽略
    if (rel.includes('/') || rel.includes('\\')) return
    // API 重命名期间跳过新旧路径事件：避免新路径被提前建索引、旧路径索引被提前误删
    if (isWatcherPathSuspended(rel)) return
    if (event === 'unlink' || event === 'unlinkDir') {
      void removeNoteByPath(rel)
    } else if (event === 'add' || event === 'change') {
      debouncedSync(rel)
    }
  })
  return watcher
}