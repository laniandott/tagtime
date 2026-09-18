import type {
  Category,
  Tag,
  TimeEntry,
  Todo,
  Summary,
  DailyStat,
  TagStat,
  FragmentationStat,
  Goal,
  Memo,
  CalendarSubscription,
  CalendarEvent,
  NoteListEntry,
  NoteDetail,
  NoteVault,
  NoteAutocompleteEntry,
  GraphData,
  RelatedEntities,
  EntityLinkType,
  LinkedNoteEntry,
} from './types'
import { enqueuePending, loadCachedSnapshot, loadPendingQueue, runSync } from './sync'
import { loadLocalBucket, saveLocalBucket, saveLocalRecord } from './localStore'

export function getServerHost(): string {
  if (typeof localStorage !== 'undefined') {
    try {
      const custom = localStorage.getItem('tagtime_server_url')
      const normalized = normalizeServerHost(custom)
      if (normalized) return normalized
    } catch {
      // 某些隐私模式/受限 WebView 会让 localStorage 读取抛异常，
      // 此时回退到构建配置或当前页面地址，不应让整个 API 层白屏。
    }
  }
  const configured = import.meta.env?.VITE_API_URL
  const normalizedConfigured = normalizeServerHost(configured)
  if (normalizedConfigured) return normalizedConfigured
  if (typeof window !== 'undefined') {
    const protocol = window.location.protocol

    const isNative = Boolean(
      (window as any).Capacitor?.isNativePlatform?.() ||
      protocol === 'capacitor:' ||
      protocol === 'file:'
    )
    if (isNative) {
      return 'http://812264226.xyz:3000'
    }
  }
  return ''
}

/**
 * 服务器地址只接受 HTTP(S) origin/base URL。
 * 这样可以避免错误配置把请求或附件地址拼成 javascript:、file: 等危险协议，
 * 同时把旧配置中的尾部斜杠统一掉。
 */
export function normalizeServerHost(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return ''
    return parsed.toString().replace(/\/$/, '')
  } catch {
    return ''
  }
}

export function resolveUploadUrl(path?: string | null): string {
  if (!path) return ''
  if (path.startsWith('http://') || path.startsWith('https://')) {
    try {
      const parsed = new URL(path)
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : ''
    } catch {
      return ''
    }
  }
  if (/^data:image\/(?:png|jpe?g|gif|webp|bmp|avif);/i.test(path)) {
    return path
  }
  if (path.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(path)) return ''
  const host = getServerHost()
  const cleanPath = path.startsWith('/') ? path : `/${path}`
  return `${host}${cleanPath}`
}

export function setServerHost(url: string): boolean {
  const normalized = normalizeServerHost(url)
  if (url.trim() && !normalized) return false
  if (typeof localStorage !== 'undefined') {
    try {
      if (normalized) {
        localStorage.setItem('tagtime_server_url', normalized)
      } else {
        localStorage.removeItem('tagtime_server_url')
      }
    } catch {
      // 受限 WebView 下无法持久化配置，但不应阻断当前会话。
    }
  }
  return true
}

export class ApiError extends Error {
  status: number
  data: any
  constructor(message: string, status: number, data?: any) {
    super(message)
    this.status = status
    this.data = data
  }
}

type RequestOptions = RequestInit & {
  timeout?: number
  retryDelayMs?: number
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_RETRY_DELAY_MS = 1_000

function configuredTimeout(): number {
  const value = Number(import.meta.env?.VITE_API_TIMEOUT_MS)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_REQUEST_TIMEOUT_MS
}

function isRetryableError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false
  if (error instanceof ApiError) {
    return error.status === 408 || error.status === 429 || (error.status >= 500 && error.status < 600)
  }
  if (error instanceof DOMException) return error.name === 'AbortError' || error.name === 'NetworkError'
  if (error instanceof Error) return error.name === 'AbortError' || /network|fetch/i.test(error.message)
  return false
}

async function requestOnce<T>(path: string, opts?: RequestOptions): Promise<T> {
  const host = getServerHost()
  const { timeout = configuredTimeout(), retryDelayMs: _retryDelayMs, ...fetchOptions } = opts ?? {}
  const headers = new Headers(fetchOptions.headers)
  if (typeof fetchOptions.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  const url = `${host}/api${path}`

  const controller = new AbortController()
  const originalSignal = fetchOptions.signal
  const onAbort = () => controller.abort(originalSignal?.reason)
  if (originalSignal) {
    if (originalSignal.aborted) controller.abort(originalSignal.reason)
    else originalSignal.addEventListener('abort', onAbort, { once: true })
  }

  const timeoutId = setTimeout(() => controller.abort(), timeout)
  try {
    const res = await fetch(url, {
      ...fetchOptions,
      headers,
      signal: controller.signal,
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw new ApiError(err.error ?? '请求失败', res.status, err)
    }
    const text = await res.text()
    return (text ? JSON.parse(text) : null) as T
  } finally {
    clearTimeout(timeoutId)
    originalSignal?.removeEventListener('abort', onAbort)
  }
}

export async function reqWithRetry<T>(path: string, opts?: RequestOptions): Promise<T> {
  const method = (opts?.method ?? 'GET').toUpperCase()
  const maxRetries = method === 'GET' ? 2 : 0
  const retryDelayMs = opts?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await requestOnce<T>(path, opts)
    } catch (error) {
      const isLastAttempt = attempt === maxRetries
      if (isLastAttempt || !isRetryableError(error, opts?.signal ?? undefined)) throw error
      await new Promise<void>((resolve, reject) => {
        const signal = opts?.signal
        let timer: ReturnType<typeof setTimeout> | undefined
        const onAbort = () => {
          if (timer !== undefined) clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          reject(signal?.reason ?? new DOMException('请求已取消', 'AbortError'))
        }
        const onDelayDone = () => {
          if (timer !== undefined) clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          resolve()
        }
        timer = setTimeout(onDelayDone, retryDelayMs * 2 ** attempt)
        if (signal) {
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
        }
      })
    }
  }
  throw new Error('请求重试失败')
}

// 保持现有 API 方法调用兼容，同时让所有请求经过超时与安全重试逻辑。
export const req = reqWithRetry

type OfflineBucket = 'categories' | 'tags' | 'goals' | 'todos' | 'timeEntries' | 'memos'
const RUNNING_IDS_KEY = 'tagtime.timer.running'
let timerMutationVersion = 0

function loadKnownRunningIds(): Set<string> | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(RUNNING_IDS_KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw)
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return null
  }
}

function saveKnownRunningIds(entries: TimeEntry[]): void {
  if (typeof localStorage === 'undefined') return
  try { localStorage.setItem(RUNNING_IDS_KEY, JSON.stringify(entries.map((entry) => entry.id))) } catch { /* best effort */ }
}

function rememberRunningId(id: string): void {
  const ids = loadKnownRunningIds() ?? new Set<string>()
  ids.add(id)
  try { localStorage.setItem(RUNNING_IDS_KEY, JSON.stringify(Array.from(ids))) } catch { /* best effort */ }
}

function forgetRunningId(id: string): void {
  const ids = loadKnownRunningIds() ?? new Set<string>()
  ids.delete(id)
  try { localStorage.setItem(RUNNING_IDS_KEY, JSON.stringify(Array.from(ids))) } catch { /* best effort */ }
}

function clearKnownRunningIds(): void {
  if (typeof localStorage === 'undefined') return
  try { localStorage.setItem(RUNNING_IDS_KEY, '[]') } catch { /* best effort */ }
}

function emitTimerRefresh(type: 'current' | 'pending', detail: unknown): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(`tagtime-timer-${type}-refresh`, { detail }))
}

function localId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `local-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function isOfflineError(error: unknown): boolean {
  return !(error instanceof ApiError)
}

function cachedBucket<T extends { id: string }>(bucket: OfflineBucket): T[] {
  const map = new Map<string, T>()
  const snapshot = loadCachedSnapshot()?.[bucket]
  if (Array.isArray(snapshot)) for (const item of snapshot) {
    if (item && typeof item.id === 'string') map.set(item.id, item as T)
  }
  for (const item of loadLocalBucket<T>(bucket)) map.set(item.id, item)
  const pending = loadPendingQueue()[bucket]
  if (Array.isArray(pending)) for (const item of pending) {
    if (!item || typeof item.id !== 'string') continue
    if (item.deleted) map.delete(item.id)
    else map.set(item.id, { ...map.get(item.id), ...item } as T)
  }
  return Array.from(map.values())
}

function createTimeEntryHydrator(): (entry: TimeEntry) => TimeEntry {
  const categories = new Map(cachedBucket<Category>('categories').map((category) => [category.id, category]))
  const tags = new Map(cachedBucket<Tag>('tags').map((tag) => [tag.id, {
    ...tag,
    category: categories.get(tag.categoryId ?? '') ?? tag.category ?? null,
  }]))
  const todos = new Map(cachedBucket<Todo>('todos').map((todo) => [todo.id, {
    ...todo,
    category: categories.get(todo.categoryId ?? '') ?? todo.category ?? null,
    tag: tags.get(todo.tagId ?? '') ?? todo.tag ?? null,
  }]))
  return (entry) => ({
    ...entry,
    tag: tags.get(entry.tagId) ?? entry.tag ?? null,
    todo: todos.get(entry.todoId ?? '') ?? entry.todo ?? null,
  })
}

export function hydrateTimeEntries(entries: TimeEntry[]): TimeEntry[] {
  const hydrate = createTimeEntryHydrator()
  return entries.map(hydrate)
}

function queueOffline(bucket: OfflineBucket, item: Record<string, unknown>): any {
  saveLocalRecord(bucket, item as { id: string; deleted?: boolean })
  enqueuePending({ [bucket]: [item] } as any)
  void runSync()
  return item
}

async function offlineList<T extends { id: string }>(request: () => Promise<T[]>, bucket: OfflineBucket, replace = true): Promise<T[]> {
  const local = cachedBucket<T>(bucket)
  if (local.length) {
    void request().then((items) => {
      if (replace) saveLocalBucket(bucket, items)
      else for (const item of items) saveLocalRecord(bucket, item)
    }).catch(() => {})
    return local
  }
  try {
    const items = await request()
    if (replace) saveLocalBucket(bucket, items)
    else for (const item of items) saveLocalRecord(bucket, item)
    return items
  } catch (error) {
    if (!isOfflineError(error)) throw error
    return local
  }
}

function remember<T extends { id: string }>(bucket: OfflineBucket, item: T): T {
  saveLocalRecord(bucket, item)
  return item
}

function forget(bucket: OfflineBucket, id: string): void {
  saveLocalRecord(bucket, { id, deleted: true })
}

function localTimeEntries(params?: { from?: string; to?: string; tagId?: string }): TimeEntry[] {
  return hydrateTimeEntries(cachedBucket<TimeEntry>('timeEntries')).filter((entry) => {
    const start = new Date(entry.startTime).getTime()
    if (params?.from && start < new Date(params.from).getTime()) return false
    if (params?.to && start > new Date(params.to).getTime()) return false
    if (params?.tagId && entry.tagId !== params.tagId) return false
    return true
  })
}

function localPendingEntries(): TimeEntry[] {
  return cachedBucket<TimeEntry>('timeEntries').filter((entry) => entry.pendingResume && !entry.dismissed)
}

function localRunningEntries(): TimeEntry[] {
  const known = loadKnownRunningIds()
  const queuedIds = new Set(
    (loadPendingQueue().timeEntries ?? [])
      .filter((item: any) => !item.deleted && !item.endTime && !item.dismissed)
      .map((item: TimeEntry) => item.id),
  )
  return cachedBucket<TimeEntry>('timeEntries').filter((entry) => {
    if (entry.endTime || entry.dismissed) return false
    return !known || known.has(entry.id) || queuedIds.has(entry.id)
  })
}

function reconcilePendingCache(remotePending: TimeEntry[]): void {
  const remoteIds = new Set(remotePending.map((entry) => entry.id))
  const queuedIds = new Set((loadPendingQueue().timeEntries ?? []).map((entry: TimeEntry) => entry.id))
  for (const entry of cachedBucket<TimeEntry>('timeEntries')) {
    if (entry.pendingResume && !remoteIds.has(entry.id) && !queuedIds.has(entry.id)) {
      saveLocalRecord('timeEntries', { ...entry, pendingResume: false })
    }
  }
  for (const entry of remotePending) saveLocalRecord('timeEntries', entry)
}

function localDuration(entry: TimeEntry, from?: number, to?: number): number {
  if (entry.dismissed) return 0
  const start = new Date(entry.startTime).getTime()
  const end = entry.endTime ? new Date(entry.endTime).getTime() : Date.now()
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0
  const clippedStart = Math.max(start, from ?? start)
  const clippedEnd = Math.min(end, to ?? end)
  return Math.max(0, clippedEnd - clippedStart)
}

function localStatsFilter(entry: TimeEntry, categoryId?: string): boolean {
  if (!categoryId) return true
  return cachedBucket<Tag>('tags').find((tag) => tag.id === entry.tagId)?.categoryId === categoryId
}

function localSummary(categoryId?: string): Summary {
  const now = new Date()
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const weekStart = dayStart - ((now.getDay() + 6) % 7) * 86400000
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
  const tags = cachedBucket<Tag>('tags')
  const categories = cachedBucket<Category>('categories')
  const entries = cachedBucket<TimeEntry>('timeEntries').filter((entry) => localStatsFilter(entry, categoryId))
  const todayByCategory = new Map<string, number>()
  for (const entry of entries) {
    const category = categories.find((item) => item.id === tags.find((tag) => tag.id === entry.tagId)?.categoryId)
    if (!category) continue
    todayByCategory.set(category.id, (todayByCategory.get(category.id) ?? 0) + localDuration(entry, dayStart, now.getTime()))
  }
  return {
    today: entries.reduce((sum, entry) => sum + localDuration(entry, dayStart), 0),
    week: entries.reduce((sum, entry) => sum + localDuration(entry, weekStart), 0),
    month: entries.reduce((sum, entry) => sum + localDuration(entry, monthStart), 0),
    todayByCategory: Array.from(todayByCategory, ([id, ms]) => {
      const category = categories.find((item) => item.id === id)
      return { name: category?.name ?? '未分类', color: category?.color ?? '#6d5efc', ms }
    }),
  }
}

function localDaily(params: { days?: number; from?: string; to?: string; categoryId?: string }): DailyStat[] {
  const now = new Date()
  const start = params.from ? new Date(params.from) : new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((params.days ?? 7) - 1))
  const end = params.to ? new Date(params.to) : now
  const result: DailyStat[] = []
  for (const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate()); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    const dayStart = cursor.getTime()
    const dayEnd = dayStart + 86400000
    const total = cachedBucket<TimeEntry>('timeEntries').filter((entry) => localStatsFilter(entry, params.categoryId)).reduce((sum, entry) => sum + localDuration(entry, dayStart, dayEnd), 0)
    result.push({ date: cursor.toISOString().slice(0, 10), total, byCategory: [] })
  }
  return result
}

function localByTag(from?: string, to?: string, categoryId?: string): TagStat[] {
  const start = from ? new Date(from).getTime() : undefined
  const end = to ? new Date(to).getTime() : undefined
  const tags = cachedBucket<Tag>('tags')
  const categories = cachedBucket<Category>('categories')
  const totals = new Map<string, number>()
  for (const entry of cachedBucket<TimeEntry>('timeEntries')) {
    if (!localStatsFilter(entry, categoryId)) continue
    totals.set(entry.tagId, (totals.get(entry.tagId) ?? 0) + localDuration(entry, start, end))
  }
  return Array.from(totals, ([tagId, ms]) => {
    const tag = tags.find((item) => item.id === tagId)
    const category = categories.find((item) => item.id === tag?.categoryId)
    return { tagId, tagName: tag?.name ?? '未分类', color: tag?.color ?? '#6d5efc', category: category?.name ?? null, ms }
  }).sort((a, b) => b.ms - a.ms)
}

function localFragmentation(from?: string, to?: string): { tags: FragmentationStat[] } {
  const start = from ? new Date(from).getTime() : undefined
  const end = to ? new Date(to).getTime() : undefined
  const groups = new Map<string, TimeEntry[]>()
  for (const entry of cachedBucket<TimeEntry>('timeEntries')) {
    if (localDuration(entry, start, end) > 0) groups.set(entry.tagId, [...(groups.get(entry.tagId) ?? []), entry])
  }
  const tags = cachedBucket<Tag>('tags')
  return { tags: Array.from(groups, ([tagId, entries]) => {
    const starts = entries.map((entry) => new Date(entry.startTime).getTime()).filter(Number.isFinite)
    const ends = entries.map((entry) => new Date(entry.endTime ?? new Date()).getTime()).filter(Number.isFinite)
    const focusedMs = entries.reduce((sum, entry) => sum + localDuration(entry, start, end), 0)
    const spanMs = Math.max(0, Math.min(Math.max(...ends, 0), end ?? Math.max(...ends, 0)) - Math.max(Math.min(...starts), start ?? Math.min(...starts)))
    return { tagId, tagName: tags.find((tag) => tag.id === tagId)?.name ?? '未分类', focusedMs, spanMs, ratio: spanMs ? focusedMs / spanMs : 0, interruptCount: Math.max(0, entries.length - 1) }
  }) }
}

function offlineRecord(bucket: OfflineBucket, id: string | undefined, data: Record<string, unknown>): Record<string, unknown> {
  const now = new Date().toISOString()
  const existing = id ? cachedBucket<{ id: string } & Record<string, unknown>>(bucket).find((item) => item.id === id) : undefined
  return { ...existing, ...data, id: id ?? localId(), createdAt: existing?.createdAt ?? data.createdAt ?? now, updatedAt: now }
}

// 分类
export const api = {
  categories: {
    list: () => offlineList(() => req<Category[]>('/categories'), 'categories'),
    create: async (data: Partial<Category>) => {
      try { return remember('categories', await req<Category>('/categories', { method: 'POST', body: JSON.stringify(data) })) } catch (error) {
        if (!isOfflineError(error)) throw error
        return queueOffline('categories', offlineRecord('categories', undefined, {
          name: data.name ?? '', color: data.color ?? '#6d5efc', icon: data.icon ?? null, sortOrder: data.sortOrder ?? 0,
        })) as Category
      }
    },
    update: async (id: string, data: Partial<Category>) => {
      try { return remember('categories', await req<Category>(`/categories/${id}`, { method: 'PUT', body: JSON.stringify(data) })) } catch (error) {
        if (!isOfflineError(error)) throw error
        return queueOffline('categories', offlineRecord('categories', id, data as Record<string, unknown>)) as Category
      }
    },
    remove: async (id: string) => {
      try { await req(`/categories/${id}`, { method: 'DELETE' }); forget('categories', id); return null } catch (error) {
        if (!isOfflineError(error)) throw error
        return queueOffline('categories', { id, deleted: true })
      }
    },
  },
  tags: {
    list: () => offlineList(() => req<Tag[]>('/tags'), 'tags'),
    create: async (data: Partial<Tag> & { name: string }) => {
      try { return remember('tags', await req<Tag>('/tags', { method: 'POST', body: JSON.stringify(data) })) } catch (error) {
        if (!isOfflineError(error)) throw error
        return queueOffline('tags', offlineRecord('tags', undefined, {
          name: data.name, color: data.color ?? '#6d5efc', icon: data.icon ?? null, categoryId: data.categoryId ?? null,
          parentId: data.parentId ?? null, trackType: data.trackType ?? 'time', mode: data.mode ?? 'chaos', sortOrder: data.sortOrder ?? 0,
        })) as Tag
      }
    },
    update: async (id: string, data: Partial<Tag>) => {
      try { return remember('tags', await req<Tag>(`/tags/${id}`, { method: 'PUT', body: JSON.stringify(data) })) } catch (error) {
        if (!isOfflineError(error)) throw error
        return queueOffline('tags', offlineRecord('tags', id, data as Record<string, unknown>)) as Tag
      }
    },
    remove: async (id: string) => {
      try { await req(`/tags/${id}`, { method: 'DELETE' }); forget('tags', id); return null } catch (error) {
        if (!isOfflineError(error)) throw error
        return queueOffline('tags', { id, parentId: cachedBucket<Tag>('tags').find((tag) => tag.id === id)?.parentId ?? null, deleted: true })
      }
    },
  },
  timer: {
    current: async () => {
      const local = cachedBucket<TimeEntry>('timeEntries')
      if (local.length) {
        const requestVersion = timerMutationVersion
        void req<{ running: TimeEntry[]; serverTime: string }>('/timer/current').then((data) => {
          if (requestVersion !== timerMutationVersion) return
          saveKnownRunningIds(data.running)
          for (const entry of data.running) saveLocalRecord('timeEntries', entry)
          emitTimerRefresh('current', data)
        }).catch(() => {})
        return { running: hydrateTimeEntries(localRunningEntries()), serverTime: new Date().toISOString() }
      }
      try {
        const requestVersion = timerMutationVersion
        const data = await req<{ running: TimeEntry[]; serverTime: string }>('/timer/current')
        if (requestVersion !== timerMutationVersion) {
          return { running: hydrateTimeEntries(localRunningEntries()), serverTime: data.serverTime }
        }
        saveKnownRunningIds(data.running)
        for (const entry of data.running) saveLocalRecord('timeEntries', entry)
        return data
      } catch (error) {
        if (!isOfflineError(error)) throw error
        return { running: hydrateTimeEntries(localRunningEntries()), serverTime: new Date().toISOString() }
      }
    },
    start: async (data: { tagId: string; note?: string; todoId?: string; resumedFromId?: string; interruptedFromId?: string }) => {
      timerMutationVersion++
      const id = localId()
      const startTime = new Date().toISOString()
      try {
        const result = await req<TimeEntry & { serverTime: string }>('/timer/start', { method: 'POST', body: JSON.stringify({ ...data, id }) })
        remember('timeEntries', result)
        rememberRunningId(result.id)
        if (data.resumedFromId) {
          const parent = cachedBucket<TimeEntry>('timeEntries').find((entry) => entry.id === data.resumedFromId)
          if (parent) saveLocalRecord('timeEntries', { ...parent, pendingResume: false })
        }
        return result
      } catch (error) {
        if (!isOfflineError(error)) throw error
        if (data.resumedFromId) {
          const parent = cachedBucket<TimeEntry>('timeEntries').find((entry) => entry.id === data.resumedFromId)
          if (parent) queueOffline('timeEntries', { ...parent, pendingResume: false })
        }
        const local = queueOffline('timeEntries', offlineRecord('timeEntries', id, {
          startTime, endTime: null, note: data.note ?? null, tagId: data.tagId, todoId: data.todoId ?? null,
          pendingResume: false, dismissed: false, dismissReason: null, resumedFromId: data.resumedFromId ?? null, interruptedFromId: data.interruptedFromId ?? null,
        })) as TimeEntry
        return { ...hydrateTimeEntries([local])[0], serverTime: new Date().toISOString() }
      }
    },
    stop: async (id: string, note?: string, pendingResume?: boolean) => {
      timerMutationVersion++
      try {
        const result = await req<TimeEntry>(`/timer/stop/${id}`, { method: 'POST', body: JSON.stringify({ note, pendingResume }) })
        forgetRunningId(id)
        return remember('timeEntries', result)
      } catch (error) {
        if (!isOfflineError(error)) throw error
        const current = cachedBucket<TimeEntry>('timeEntries').find((entry) => entry.id === id)
        if (!current) throw error
        return queueOffline('timeEntries', { ...current, endTime: new Date().toISOString(), note: note ?? current.note, pendingResume: pendingResume === true }) as TimeEntry
      }
    },
    stopAll: async () => {
      timerMutationVersion++
      try {
        const result = await req<{ count: number }>('/timer/stop', { method: 'POST' })
        clearKnownRunningIds()
        return result
      } catch (error) {
        if (!isOfflineError(error)) throw error
        const running = cachedBucket<TimeEntry>('timeEntries').filter((entry) => !entry.endTime && !entry.dismissed)
        for (const entry of running) queueOffline('timeEntries', { ...entry, endTime: new Date().toISOString() })
        return { count: running.length }
      }
    },
    quick: async (data: { tagId: string; note?: string; todoId?: string }) => {
      try {
        const result = await req<TimeEntry & { serverTime: string }>('/timer/quick', { method: 'POST', body: JSON.stringify(data) })
        remember('timeEntries', result)
        return result
      } catch (error) {
        if (!isOfflineError(error)) throw error
        const now = new Date().toISOString()
        const local = queueOffline('timeEntries', offlineRecord('timeEntries', undefined, {
          startTime: now, endTime: now, note: data.note ?? null, tagId: data.tagId, todoId: data.todoId ?? null,
          pendingResume: false, dismissed: false, dismissReason: null, resumedFromId: null, interruptedFromId: null,
        })) as TimeEntry
        return { ...local, serverTime: now }
      }
    },
    list: (params?: { from?: string; to?: string; tagId?: string }) => {
      const q = new URLSearchParams()
      if (params?.from) q.set('from', params.from)
      if (params?.to) q.set('to', params.to)
      if (params?.tagId) q.set('tagId', params.tagId)
      return offlineList(async () => req<TimeEntry[]>(`/timer?${q}`), 'timeEntries', false).then((items) => hydrateTimeEntries(items).filter((entry) => {
        const start = new Date(entry.startTime).getTime()
        return (!params?.from || start >= new Date(params.from).getTime()) &&
          (!params?.to || start <= new Date(params.to).getTime()) &&
          (!params?.tagId || entry.tagId === params.tagId)
      }))
    },
    pending: async () => {
      const local = localPendingEntries()
      if (local.length) {
        const requestVersion = timerMutationVersion
        void req<{ serverTime: string; pending: TimeEntry[] }>('/timer/pending').then((data) => {
          if (requestVersion !== timerMutationVersion) return
          reconcilePendingCache(data.pending)
          emitTimerRefresh('pending', data)
        }).catch(() => {})
        return { serverTime: new Date().toISOString(), pending: hydrateTimeEntries(local) }
      }
      try {
        const requestVersion = timerMutationVersion
        const data = await req<{ serverTime: string; pending: TimeEntry[] }>('/timer/pending')
        if (requestVersion !== timerMutationVersion) {
          return { serverTime: data.serverTime, pending: hydrateTimeEntries(localPendingEntries()) }
        }
        reconcilePendingCache(data.pending)
        return data
      } catch (error) {
        if (!isOfflineError(error)) throw error
        return { serverTime: new Date().toISOString(), pending: hydrateTimeEntries(localPendingEntries()) }
      }
    },
    dismissPending: async (id: string, reason: string) => {
      timerMutationVersion++
      try {
        const result = await req<TimeEntry>(`/timer/${id}/dismiss-pending`, { method: 'POST', body: JSON.stringify({ reason }) })
        return remember('timeEntries', result)
      } catch (error) {
        if (!isOfflineError(error)) throw error
        const current = cachedBucket<TimeEntry>('timeEntries').find((entry) => entry.id === id)
        if (!current) throw error
        const trimmed = reason.trim()
        const note = current.note ? `${current.note}\n—— 已丢弃：${trimmed}` : `—— 已丢弃：${trimmed}`
        return queueOffline('timeEntries', { ...current, pendingResume: false, dismissed: true, dismissReason: trimmed, note }) as TimeEntry
      }
    },
    finishPending: async (id: string) => {
      timerMutationVersion++
      try {
        const result = await req<TimeEntry>(`/timer/${id}/finish-pending`, { method: 'POST' })
        return remember('timeEntries', result)
      } catch (error) {
        if (!isOfflineError(error)) throw error
        const current = cachedBucket<TimeEntry>('timeEntries').find((entry) => entry.id === id)
        if (!current) throw error
        return queueOffline('timeEntries', { ...current, pendingResume: false }) as TimeEntry
      }
    },
    terminateChain: (id: string, reason: string) =>
      req<{ count: number }>(`/timer/${id}/terminate-chain`, { method: 'POST', body: JSON.stringify({ reason }) }),
    remove: async (id: string) => {
      try {
        await req(`/timer/${id}`, { method: 'DELETE' })
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 404) && !isOfflineError(error)) throw error
      }
      return queueOffline('timeEntries', { id, deleted: true })
    },
    manual: async (data: { tagId: string; startTime: string; endTime: string; note?: string; todoId?: string }) => {
      try {
        const result = await req<TimeEntry>('/timer/manual', { method: 'POST', body: JSON.stringify(data) })
        return remember('timeEntries', result)
      } catch (error) {
        if (!isOfflineError(error)) throw error
        return queueOffline('timeEntries', offlineRecord('timeEntries', undefined, {
          ...data, note: data.note ?? null, pendingResume: false, dismissed: false, dismissReason: null, resumedFromId: null, interruptedFromId: null,
        })) as TimeEntry
      }
    },
    update: async (id: string, data: { startTime?: string; endTime?: string | null; note?: string; tagId?: string; todoId?: string | null }) => {
      try {
        const result = await req<TimeEntry>(`/timer/${id}`, { method: 'PUT', body: JSON.stringify(data) })
        return remember('timeEntries', result)
      } catch (error) {
        if (!isOfflineError(error)) throw error
        return queueOffline('timeEntries', offlineRecord('timeEntries', id, data as Record<string, unknown>)) as TimeEntry
      }
    },
  },
  todos: {
    list: (params?: { status?: string; categoryId?: string; tagId?: string; repeatType?: string }) => {
      const q = new URLSearchParams()
      if (params?.status) q.set('status', params.status)
      if (params?.categoryId) q.set('categoryId', params.categoryId)
      if (params?.tagId) q.set('tagId', params.tagId)
      if (params?.repeatType) q.set('repeatType', params.repeatType)
      return offlineList(async () => req<Todo[]>(`/todos?${q}`), 'todos', false).then((items) => items.filter((todo) =>
        (!params?.status || todo.status === params.status) &&
        (!params?.categoryId || todo.categoryId === params.categoryId) &&
        (!params?.tagId || todo.tagId === params.tagId) &&
        (!params?.repeatType || todo.repeatType === params.repeatType)
      ))
    },
    create: async (data: Partial<Todo> & { title: string }) => {
      try { return remember('todos', await req<Todo>('/todos', { method: 'POST', body: JSON.stringify(data) })) } catch (error) {
        if (!isOfflineError(error)) throw error
        return queueOffline('todos', offlineRecord('todos', undefined, {
          title: data.title, description: data.description ?? null, status: data.status ?? 'pending', priority: data.priority ?? 0,
          dueDate: data.dueDate ?? null, categoryId: data.categoryId ?? null, tagId: data.tagId ?? null, goalId: data.goalId ?? null,
          repeatType: data.repeatType ?? 'none', completedAt: data.completedAt ?? null, lateReason: data.lateReason ?? null, restoreReason: data.restoreReason ?? null,
        })) as Todo
      }
    },
    update: async (id: string, data: Partial<Todo>) => {
      try { return remember('todos', await req<Todo>(`/todos/${id}`, { method: 'PUT', body: JSON.stringify(data) })) } catch (error) {
        if (!isOfflineError(error)) throw error
        return queueOffline('todos', offlineRecord('todos', id, data as Record<string, unknown>)) as Todo
      }
    },
    toggle: async (id: string, lateReason?: string, restoreReason?: string) => {
      try { return remember('todos', await req<Todo>(`/todos/${id}/toggle`, { method: 'PATCH', body: JSON.stringify({ lateReason, restoreReason }) })) } catch (error) {
        if (!isOfflineError(error)) throw error
        const current = cachedBucket<Todo>('todos').find((todo) => todo.id === id)
        if (!current) throw error
        const done = current.status === 'done'
        return queueOffline('todos', offlineRecord('todos', id, {
          status: done ? 'pending' : 'done', completedAt: done ? null : new Date().toISOString(),
          lateReason: lateReason ?? current.lateReason ?? null, restoreReason: restoreReason ?? current.restoreReason ?? null,
        })) as Todo
      }
    },
    remove: async (id: string) => {
      try { await req(`/todos/${id}`, { method: 'DELETE' }); forget('todos', id); return null } catch (error) {
        if (!isOfflineError(error)) throw error
        return queueOffline('todos', { id, deleted: true })
      }
    },
  },
  stats: {
    summary: async (categoryId?: string) => {
      const qs = categoryId ? `?${new URLSearchParams({ categoryId }).toString()}` : ''
      const local = cachedBucket<TimeEntry>('timeEntries')
      if (local.length) {
        void req<Summary>(`/stats/summary${qs}`).catch(() => {})
        return localSummary(categoryId)
      }
      try { return await req<Summary>(`/stats/summary${qs}`) } catch (error) {
        if (!isOfflineError(error)) throw error
        return localSummary(categoryId)
      }
    },
    daily: async (params: { days?: number; from?: string; to?: string; categoryId?: string } = {}) => {
      const q = new URLSearchParams()
      if (params.days) q.set('days', String(params.days))
      if (params.from) q.set('from', params.from)
      if (params.to) q.set('to', params.to)
      if (params.categoryId) q.set('categoryId', params.categoryId)
      const local = cachedBucket<TimeEntry>('timeEntries')
      if (local.length) {
        void req<DailyStat[]>(`/stats/daily?${q}`).catch(() => {})
        return localDaily(params)
      }
      try { return await req<DailyStat[]>(`/stats/daily?${q}`) } catch (error) {
        if (!isOfflineError(error)) throw error
        return localDaily(params)
      }
    },
    byTag: async (from?: string, to?: string, categoryId?: string) => {
      const q = new URLSearchParams()
      if (from) q.set('from', from)
      if (to) q.set('to', to)
      if (categoryId) q.set('categoryId', categoryId)
      const qs = q.toString()
      const local = cachedBucket<TimeEntry>('timeEntries')
      if (local.length) {
        void req<TagStat[]>(`/stats/by-tag${qs ? `?${qs}` : ''}`).catch(() => {})
        return localByTag(from, to, categoryId)
      }
      try { return await req<TagStat[]>(`/stats/by-tag${qs ? `?${qs}` : ''}`) } catch (error) {
        if (!isOfflineError(error)) throw error
        return localByTag(from, to, categoryId)
      }
    },
    fragmentation: async (from?: string, to?: string) => {
      const q = new URLSearchParams()
      if (from) q.set('from', from)
      if (to) q.set('to', to)
      const qs = q.toString()
      const local = cachedBucket<TimeEntry>('timeEntries')
      if (local.length) {
        void req<{ tags: FragmentationStat[] }>(`/stats/fragmentation${qs ? `?${qs}` : ''}`).catch(() => {})
        return localFragmentation(from, to)
      }
      try { return await req<{ tags: FragmentationStat[] }>(`/stats/fragmentation${qs ? `?${qs}` : ''}`) } catch (error) {
        if (!isOfflineError(error)) throw error
        return localFragmentation(from, to)
      }
    },
  },
  goals: {
    list: () => offlineList(() => req<Goal[]>('/goals'), 'goals'),
    create: async (data: { tagId: string; title: string; kind?: string; type?: string; target?: number; period?: string; periodDays?: number | null; deadlineTime?: string | null; deadlineDay?: number | null; deadlineAt?: string | null }) => {
      try { return remember('goals', await req<Goal>('/goals', { method: 'POST', body: JSON.stringify(data) })) } catch (error) {
        if (!isOfflineError(error)) throw error
        return queueOffline('goals', offlineRecord('goals', undefined, {
          tagId: data.tagId, title: data.title, kind: data.kind ?? 'tracking', type: data.type ?? 'count', target: data.target ?? 1,
          period: data.period ?? 'daily', periodDays: data.periodDays ?? null, deadlineTime: data.deadlineTime ?? null,
          deadlineDay: data.deadlineDay ?? null, deadlineAt: data.deadlineAt ?? null, active: true,
        })) as Goal
      }
    },
    update: async (id: string, data: Partial<Goal>) => {
      try { return remember('goals', await req<Goal>(`/goals/${id}`, { method: 'PUT', body: JSON.stringify(data) })) } catch (error) {
        if (!isOfflineError(error)) throw error
        return queueOffline('goals', offlineRecord('goals', id, data as Record<string, unknown>)) as Goal
      }
    },
    remove: async (id: string) => {
      try { await req(`/goals/${id}`, { method: 'DELETE' }); forget('goals', id); return null } catch (error) {
        if (!isOfflineError(error)) throw error
        return queueOffline('goals', { id, deleted: true })
      }
    },
  },
  memos: {
    list: (params?: { timeEntryId?: string; tagId?: string; days?: number; from?: string; to?: string; standaloneOnly?: boolean | string; type?: string }) => {
      const q = new URLSearchParams()
      if (params?.timeEntryId) q.set('timeEntryId', params.timeEntryId)
      if (params?.tagId) q.set('tagId', params.tagId)
      if (params?.days) q.set('days', String(params.days))
      if (params?.from) q.set('from', params.from)
      if (params?.to) q.set('to', params.to)
      if (params?.standaloneOnly) q.set('standaloneOnly', String(params.standaloneOnly))
      if (params?.type) q.set('type', params.type)
      return offlineList(async () => req<Memo[]>(`/memos?${q}`), 'memos', false).then((items) => items.filter((memo) => {
        if (params?.timeEntryId && memo.timeEntryId !== params.timeEntryId) return false
        if (params?.tagId && memo.tagId !== params.tagId) return false
        if (params?.type && memo.type !== params.type) return false
        if (params?.standaloneOnly && memo.timeEntryId) return false
        const created = new Date(memo.createdAt).getTime()
        if (params?.from && created < new Date(params.from).getTime()) return false
        if (params?.to && created > new Date(params.to).getTime()) return false
        if (params?.days && created < Date.now() - params.days * 24 * 60 * 60 * 1000) return false
        return true
      }))
    },
    create: async (data: {
      content: string
      type?: 'point' | 'diary'
      timeEntryId?: string
      tagId?: string
      createdAt?: string
      attachments?: { filename: string; path: string; mimeType: string; size: number }[]
    }) => {
      try { return remember('memos', await req<Memo>('/memos', { method: 'POST', body: JSON.stringify(data) })) } catch (error) {
        if (!isOfflineError(error)) throw error
        return queueOffline('memos', offlineRecord('memos', undefined, {
          content: data.content, type: data.type ?? 'diary', timeEntryId: data.timeEntryId ?? null, tagId: data.tagId ?? null,
          ...(data.createdAt ? { createdAt: data.createdAt } : {}), attachments: data.attachments ?? [],
        })) as Memo
      }
    },
    update: async (id: string, data: {
      content?: string
      createdAt?: string
      attachments?: { filename: string; path: string; mimeType: string; size: number }[]
    }) => {
      try { return remember('memos', await req<Memo>(`/memos/${id}`, { method: 'PUT', body: JSON.stringify(data) })) } catch (error) {
        if (!isOfflineError(error)) throw error
        return queueOffline('memos', offlineRecord('memos', id, data as Record<string, unknown>)) as Memo
      }
    },
    upload: async (file: File) => {
      const host = getServerHost()
      const form = new FormData()
      form.append('file', file, file.name || 'upload.bin')
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 60_000)
      const request = (url: string) => fetch(url, {
        method: 'POST',
        body: form,
        signal: controller.signal,
      })
      let res: Response
      try {
        res = await request(`${host}/api/memos/upload`)
      } catch (firstError) {
        // HTTPS pages cannot call a stale HTTP server URL; retry through same origin.
        if (!controller.signal.aborted && typeof window !== 'undefined' && window.location.protocol === 'https:' && host) {
          res = await request('/api/memos/upload')
        } else {
          throw firstError
        }
      } finally {
        clearTimeout(timeoutId)
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `${res.status} ${res.statusText}` }))
        throw new Error(err.error ?? `上传文件失败 (${res.status})`)
      }
      return res.json() as Promise<{ filename: string; path: string; mimeType: string; size: number }>
    },
    remove: async (id: string) => {
      try { await req(`/memos/${id}`, { method: 'DELETE' }); forget('memos', id); return null } catch (error) {
        if (!isOfflineError(error)) throw error
        return queueOffline('memos', { id, deleted: true })
      }
    },
  },
  calendars: {
    subscriptions: {
      list: () => req<CalendarSubscription[]>('/calendars/subscriptions'),
      create: (data: { name: string; url: string; color?: string }) =>
        req<CalendarSubscription>('/calendars/subscriptions', { method: 'POST', body: JSON.stringify(data) }),
      update: (id: string, data: Partial<CalendarSubscription>) =>
        req<CalendarSubscription>(`/calendars/subscriptions/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
      remove: (id: string) => req(`/calendars/subscriptions/${id}`, { method: 'DELETE' }),
      sync: (id: string) =>
        req<{ ok: boolean; count: number }>(`/calendars/subscriptions/${id}/sync`, { method: 'POST' }),
    },
    events: (params?: { from?: string; to?: string }) => {
      const q = new URLSearchParams()
      if (params?.from) q.set('from', params.from)
      if (params?.to) q.set('to', params.to)
      const qs = q.toString()
      return req<CalendarEvent[]>(`/calendars/external-events${qs ? `?${qs}` : ''}`)
    },
  },
  notes: {
    vault: () => req<NoteVault>('/notes/vault'),
    setVault: (path: string) =>
      req<NoteVault>('/notes/vault', { method: 'POST', body: JSON.stringify({ path }) }),
    list: (q?: string) => {
      const qs = q ? `?q=${encodeURIComponent(q)}` : ''
      return req<NoteListEntry[]>(`/notes${qs}`)
    },
    get: (id: string) => req<NoteDetail>(`/notes/${id}`),
    create: (data: { title: string; content?: string; folder?: string }) =>
      req<{ id: string; path: string; revision: number }>('/notes', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: { content: string; revision: number }) =>
      req<{ id: string; path: string; revision: number }>(`/notes/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    rename: (id: string, data: { title?: string; folder?: string }) =>
      req<{ id: string; path: string; title: string; revision: number }>(`/notes/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    folders: () => req<{ folders: string[] }>('/notes/folders'),
    createFolder: (path: string) =>
      req<{ path: string }>('/notes/folders', { method: 'POST', body: JSON.stringify({ path }) }),
    removeFolder: (path: string) =>
      req<{ ok: boolean }>(`/notes/folders?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
    remove: (id: string) => req<{ ok: boolean }>(`/notes/${id}`, { method: 'DELETE' }),
    autocomplete: (q: string) => {
      const qs = q ? `?q=${encodeURIComponent(q)}` : ''
      return req<NoteAutocompleteEntry[]>(`/notes/autocomplete${qs}`)
    },
    globalGraph: (params?: { q?: string; dir?: string; recent?: number; limit?: number }) => {
      const q = new URLSearchParams()
      if (params?.q) q.set('q', params.q)
      if (params?.dir) q.set('dir', params.dir)
      if (params?.recent != null) q.set('recent', String(params.recent))
      if (params?.limit != null) q.set('limit', String(params.limit))
      const qs = q.toString()
      return req<GraphData>(`/notes/graph${qs ? `?${qs}` : ''}`)
    },
    localGraph: (id: string, depth = 1) =>
      req<GraphData>(`/notes/${id}/graph?depth=${depth}`),
    entities: (id: string) => req<RelatedEntities>(`/notes/${id}/entities`),
    linked: (type: EntityLinkType, key: string) =>
      req<LinkedNoteEntry[]>(`/notes/linked?type=${encodeURIComponent(type)}&key=${encodeURIComponent(key)}`),
  },
}
