import chokidar, { type FSWatcher } from 'chokidar'
import { relative } from 'node:path'
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
  return relative(NOTES_DIR, absPath).replace(/\\/g, '/')
}

export function trackNotesDirectory() {
  if (watcher) return watcher
  watcher = chokidar.watch(NOTES_DIR, {
    ignoreInitial: true,
    ignored: (p: string) => {
      const name = p.split(/[\\/]/).pop() || ''
      const rel = relOf(p)
      const inReservedAssets = rel.split('/')[0]?.toLowerCase() === 'assets'
      return name.endsWith('.tmp') || name.endsWith('.bak') || inReservedAssets
    },
    awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
  })

  const debouncedSync = makeFileDebounce((rel: string) => {
    // 到执行时刻仍处于暂停期（如 API 重命名）则丢弃，避免给新路径建重复索引
    if (isWatcherPathSuspended(rel)) return
    void syncNoteFile(rel, 'watcher').catch((error) => {
      // watcher 回调不在 Fastify 请求链路内，必须显式消费 rejection，
      // 否则单个文件损坏/权限异常可能升级为未处理 Promise rejection。
      console.error(`[notes-watcher] 同步失败 ${rel}:`, error)
    })
  }, 500)

  watcher.on('all', (event, absPath) => {
    if (!absPath.endsWith('.md')) return
    const rel = relOf(absPath)
    // API 重命名期间跳过新旧路径事件：避免新路径被提前建索引、旧路径索引被提前误删
    if (isWatcherPathSuspended(rel)) return
    if (event === 'unlink' || event === 'unlinkDir') {
      void removeNoteByPath(rel).catch((error) => {
        console.error(`[notes-watcher] 删除索引失败 ${rel}:`, error)
      })
    } else if (event === 'add' || event === 'change') {
      debouncedSync(rel)
    }
  })
  watcher.on('error', (error) => {
    // chokidar 的 error 事件同样不应成为未处理异常，记录后让 watcher 继续工作。
    console.error('[notes-watcher] 文件监听错误:', error)
  })
  return watcher
}
