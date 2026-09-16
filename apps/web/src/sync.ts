import { getServerHost } from './api'

export type SyncStatus = 'synced' | 'syncing' | 'offline' | 'error'

export type SyncState = {
  status: SyncStatus
  cursor: number
  lastSyncedAt: string | null
  pendingCount: number
  error?: string
}

const STORAGE_KEY = 'tagtime.sync'
const PENDING_QUEUE_KEY = 'tagtime.sync.pending'
let syncPromise: Promise<boolean> | null = null

export function loadSyncState(): SyncState {
  if (typeof localStorage === 'undefined') {
    return { status: 'synced', cursor: 0, lastSyncedAt: null, pendingCount: 0 }
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw) as SyncState
  } catch {
    // ignore corrupted state
  }
  return { status: 'synced', cursor: 0, lastSyncedAt: null, pendingCount: 0 }
}

export function saveSyncState(state: SyncState): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // quota exceeded or private mode
  }
}

export async function fetchSyncSnapshot(): Promise<any | null> {
  try {
    const host = getServerHost()
    if (!host) return null
    const res = await fetch(`${host}/api/sync`, { cache: 'no-store', signal: AbortSignal.timeout?.(10_000) })
    if (!res.ok) return null
    return res.json()
  } catch {
    return null
  }
}

export async function exchangeSync(body: {
  cursor: number
  categories: any[]
  tags: any[]
  timeEntries: any[]
  todos: any[]
  goals: any[]
  memos: any[]
}): Promise<any | null> {
  try {
    const host = getServerHost()
    if (!host) return null
    const res = await fetch(`${host}/api/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout?.(15_000),
    })
    if (!res.ok) return null
    return res.json()
  } catch {
    return null
  }
}

export async function runSync(): Promise<boolean> {
  if (syncPromise) return syncPromise
  syncPromise = runSyncInternal()
  try { return await syncPromise } finally { syncPromise = null }
}

async function runSyncInternal(): Promise<boolean> {
  const state = loadSyncState()
  if (state.status === 'syncing') return false
  saveSyncState({ ...state, status: 'syncing', error: undefined })

  try {
    const snapshot = await fetchSyncSnapshot()
    if (!snapshot) {
      saveSyncState({ ...loadSyncState(), status: 'offline' })
      return false
    }

    const remoteCursor = typeof snapshot.cursor === 'number' ? snapshot.cursor : 0
    const pending = loadPendingQueue()
    const result = await exchangeSync({
      cursor: state.cursor,
      ...pending,
    })

    if (!result) {
      saveSyncState({ ...loadSyncState(), status: 'offline' })
      return false
    }

    const nextCursor = typeof result.cursor === 'number' ? result.cursor : remoteCursor
    clearPendingQueue()
    saveSyncState({
      status: 'synced',
      cursor: nextCursor,
      lastSyncedAt: new Date().toISOString(),
      pendingCount: 0,
    })
    return true
  } catch (e: any) {
    saveSyncState({
      ...loadSyncState(),
      status: 'error',
      error: e?.message || '同步失败',
    })
    return false
  }
}

export function enqueuePending(change: {
  categories?: any[]
  tags?: any[]
  timeEntries?: any[]
  todos?: any[]
  goals?: any[]
  memos?: any[]
}): void {
  const queue = loadPendingQueue()
  const next = { ...queue }
  for (const key of ['categories', 'tags', 'timeEntries', 'todos', 'goals', 'memos'] as const) {
    const list = change[key]
    if (!Array.isArray(list) || !list.length) continue
    const current = Array.isArray(next[key]) ? next[key] : []
    const map = new Map(current.map((item: any) => [item.id, item]))
    for (const item of list) {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string') continue
      map.set(item.id, item)
    }
    next[key] = Array.from(map.values())
  }
  if (typeof localStorage === 'undefined') return
  try { localStorage.setItem(PENDING_QUEUE_KEY, JSON.stringify(next)) } catch { return }
  updatePendingCount()
}

export function loadPendingQueue(): {
  categories: any[]
  tags: any[]
  timeEntries: any[]
  todos: any[]
  goals: any[]
  memos: any[]
} {
  if (typeof localStorage === 'undefined') {
    return { categories: [], tags: [], timeEntries: [], todos: [], goals: [], memos: [] }
  }
  try {
    const raw = localStorage.getItem(PENDING_QUEUE_KEY)
    if (raw) return JSON.parse(raw)
  } catch {
    // ignore
  }
  return { categories: [], tags: [], timeEntries: [], todos: [], goals: [], memos: [] }
}

export function clearPendingQueue(): void {
  if (typeof localStorage === 'undefined') return
  localStorage.removeItem(PENDING_QUEUE_KEY)
}

export function updatePendingCount(): void {
  if (typeof localStorage === 'undefined') return
  try {
    const queue = loadPendingQueue()
    const count = Object.values(queue).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0)
    const state = loadSyncState()
    saveSyncState({ ...state, pendingCount: count })
  } catch {
    // ignore
  }
}

export function initSyncAuto(): void {
  if (typeof window === 'undefined') return
  window.addEventListener('online', () => {
    void runSync()
  })
  window.setInterval(() => { if (navigator.onLine) void runSync() }, 10_000)
}
