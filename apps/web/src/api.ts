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
  const pending = loadPendingQueue()[bucket]
  if (Array.isArray(pending)) for (const item of pending) {
    if (!item || typeof item.id !== 'string') continue
    if (item.deleted) map.delete(item.id)
    else map.set(item.id, { ...map.get(item.id), ...item } as T)
  }
  return Array.from(map.values())
}

function queueOffline(bucket: OfflineBucket, item: Record<string, unknown>): any {
  enqueuePending({ [bucket]: [item] } as any)
  void runSync()
  return item
}

async function offlineList<T extends { id: string }>(request: () => Promise<T[]>, bucket: OfflineBucket): Promise<T[]> {
  try { return await request() } catch (error) {
    if (!isOfflineError(error)) throw error
    return cachedBucket<T>(bucket)
  }
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
      try { return await req<Category>('/categories', { method: 'POST', body: JSON.stringify(data) }) } catch (error) {
        if (!isOfflineError(error)) throw error
        return queueOffline('categories', offlineRecord('categories', undefined, {
          name: data.name ?? '', color: data.color ?? '#6d5efc', icon: data.icon ?? null, sortOrder: data.sortOrder ?? 0,
        })) as Category
      }
    },
    update: async (id: string, data: Partial<Category>) => {
      try { return await req<Category>(`/categories/${id}`, { method: 'PUT', body: JSON.stringify(data) }) } catch (error) {
        if (!isOfflineError(error)) throw error
        return queueOffline('categories', offlineRecord('categories', id, data as Record<string, unknown>)) as Category
      }
    },
    remove: async (id: string) => {
      try { return await req(`/categories/${id}`, { method: 'DELETE' }) } catch (error) {
        if (!isOfflineError(error)) throw error
        return queueOffline('categories', { id, deleted: true })
      }
    },
  },
  tags: {
    list: () => offlineList(() => req<Tag[]>('/tags'), 'tags'),
    create: async (data: Partial<Tag> & { name: string }) => {
      try { return await req<Tag>('/tags', { method: 'POST', body: JSON.stringify(data) }) } catch (error) {
        if (!isOfflineError(error)) throw error
        return queueOffline('tags', offlineRecord('tags', undefined, {
          name: data.name, color: data.color ?? '#6d5efc', icon: data.icon ?? null, categoryId: data.categoryId ?? null,
          parentId: data.parentId ?? null, trackType: data.trackType ?? 'time', mode: data.mode ?? 'chaos', sortOrder: data.sortOrder ?? 0,
        })) as Tag
      }
    },
    update: async (id: string, data: Partial<Tag>) => {
      try { return await req<Tag>(`/tags/${id}`, { method: 'PUT', body: JSON.stringify(data) }) } catch (error) {
        if (!isOfflineError(error)) throw error
        return queueOffline('tags', offlineRecord('tags', id, data as Record<string, unknown>)) as Tag
      }
    },
    remove: async (id: string) => {
      try { return await req(`/tags/${id}`, { method: 'DELETE' }) } catch (error) {
        if (!isOfflineError(error)) throw error
        return queueOffline('tags', { id, parentId: cachedBucket<Tag>('tags').find((tag) => tag.id === id)?.parentId ?? null, deleted: true })
      }
    },
  },
  timer: {
    current: () => req<{ running: TimeEntry[]; serverTime: string }>('/timer/current'),
    start: (data: { tagId: string; note?: string; todoId?: string; resumedFromId?: string; interruptedFromId?: string }) =>
      req<TimeEntry & { serverTime: string }>('/timer/start', { method: 'POST', body: JSON.stringify(data) }),
    stop: (id: string, note?: string, pendingResume?: boolean) =>
      req<TimeEntry>(`/timer/stop/${id}`, { method: 'POST', body: JSON.stringify({ note, pendingResume }) }),
    stopAll: () => req<{ count: number }>('/timer/stop', { method: 'POST' }),
    quick: (data: { tagId: string; note?: string; todoId?: string }) =>
      req<TimeEntry & { serverTime: string }>('/timer/quick', { method: 'POST', body: JSON.stringify(data) }),
    list: (params?: { from?: string; to?: string; tagId?: string }) => {
      const q = new URLSearchParams()
      if (params?.from) q.set('from', params.from)
      if (params?.to) q.set('to', params.to)
      if (params?.tagId) q.set('tagId', params.tagId)
      return req<TimeEntry[]>(`/timer?${q}`)
    },
    pending: () => req<{ serverTime: string; pending: TimeEntry[] }>('/timer/pending'),
    dismissPending: (id: string, reason: string) =>
      req<TimeEntry>(`/timer/${id}/dismiss-pending`, { method: 'POST', body: JSON.stringify({ reason }) }),
    finishPending: (id: string) =>
      req<TimeEntry>(`/timer/${id}/finish-pending`, { method: 'POST' }),
    terminateChain: (id: string, reason: string) =>
      req<{ count: number }>(`/timer/${id}/terminate-chain`, { method: 'POST', body: JSON.stringify({ reason }) }),
    remove: (id: string) => req(`/timer/${id}`, { method: 'DELETE' }),
    manual: (data: { tagId: string; startTime: string; endTime: string; note?: string; todoId?: string }) =>
      req<TimeEntry>('/timer/manual', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: { startTime?: string; endTime?: string | null; note?: string; tagId?: string; todoId?: string | null }) =>
      req<TimeEntry>(`/timer/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  },
  todos: {
    list: (params?: { status?: string; categoryId?: string; tagId?: string; repeatType?: string }) => {
      const q = new URLSearchParams()
      if (params?.status) q.set('status', params.status)
      if (params?.categoryId) q.set('categoryId', params.categoryId)
      if (params?.tagId) q.set('tagId', params.tagId)
      if (params?.repeatType) q.set('repeatType', params.repeatType)
      return offlineList(async () => req<Todo[]>(`/todos?${q}`), 'todos').then((items) => items.filter((todo) =>
        (!params?.status || todo.status === params.status) &&
        (!params?.categoryId || todo.categoryId === params.categoryId) &&
        (!params?.tagId || todo.tagId === params.tagId) &&
        (!params?.repeatType || todo.repeatType === params.repeatType)
      ))
    },
    create: async (data: Partial<Todo> & { title: string }) => {
      try { return await req<Todo>('/todos', { method: 'POST', body: JSON.stringify(data) }) } catch (error) {
        if (!isOfflineError(error)) throw error
        return queueOffline('todos', offlineRecord('todos', undefined, {
          title: data.title, description: data.description ?? null, status: data.status ?? 'pending', priority: data.priority ?? 0,
          dueDate: data.dueDate ?? null, categoryId: data.categoryId ?? null, tagId: data.tagId ?? null, goalId: data.goalId ?? null,
          repeatType: data.repeatType ?? 'none', completedAt: data.completedAt ?? null, lateReason: data.lateReason ?? null, restoreReason: data.restoreReason ?? null,
        })) as Todo
      }
    },
    update: async (id: string, data: Partial<Todo>) => {
      try { return await req<Todo>(`/todos/${id}`, { method: 'PUT', body: JSON.stringify(data) }) } catch (error) {
        if (!isOfflineError(error)) throw error
        return queueOffline('todos', offlineRecord('todos', id, data as Record<string, unknown>)) as Todo
      }
    },
    toggle: async (id: string, lateReason?: string, restoreReason?: string) => {
      try { return await req<Todo>(`/todos/${id}/toggle`, { method: 'PATCH', body: JSON.stringify({ lateReason, restoreReason }) }) } catch (error) {
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
      try { return await req(`/todos/${id}`, { method: 'DELETE' }) } catch (error) {
        if (!isOfflineError(error)) throw error
        return queueOffline('todos', { id, deleted: true })
      }
    },
  },
  stats: {
    summary: (categoryId?: string) => {
      const qs = categoryId ? `?${new URLSearchParams({ categoryId }).toString()}` : ''
      return req<Summary>(`/stats/summary${qs}`)
    },
    daily: (params: { days?: number; from?: string; to?: string; categoryId?: string } = {}) => {
      const q = new URLSearchParams()
      if (params.days) q.set('days', String(params.days))
      if (params.from) q.set('from', params.from)
      if (params.to) q.set('to', params.to)
      if (params.categoryId) q.set('categoryId', params.categoryId)
      return req<DailyStat[]>(`/stats/daily?${q}`)
    },
    byTag: (from?: string, to?: string, categoryId?: string) => {
      const q = new URLSearchParams()
      if (from) q.set('from', from)
      if (to) q.set('to', to)
      if (categoryId) q.set('categoryId', categoryId)
      const qs = q.toString()
      return req<TagStat[]>(`/stats/by-tag${qs ? `?${qs}` : ''}`)
    },
    fragmentation: (from?: string, to?: string) => {
      const q = new URLSearchParams()
      if (from) q.set('from', from)
      if (to) q.set('to', to)
      const qs = q.toString()
      return req<{ tags: FragmentationStat[] }>(`/stats/fragmentation${qs ? `?${qs}` : ''}`)
    },
  },
  goals: {
    list: () => offlineList(() => req<Goal[]>('/goals'), 'goals'),
    create: async (data: { tagId: string; title: string; kind?: string; type?: string; target?: number; period?: string; periodDays?: number | null; deadlineTime?: string | null; deadlineDay?: number | null; deadlineAt?: string | null }) => {
      try { return await req<Goal>('/goals', { method: 'POST', body: JSON.stringify(data) }) } catch (error) {
        if (!isOfflineError(error)) throw error
        return queueOffline('goals', offlineRecord('goals', undefined, {
          tagId: data.tagId, title: data.title, kind: data.kind ?? 'tracking', type: data.type ?? 'count', target: data.target ?? 1,
          period: data.period ?? 'daily', periodDays: data.periodDays ?? null, deadlineTime: data.deadlineTime ?? null,
          deadlineDay: data.deadlineDay ?? null, deadlineAt: data.deadlineAt ?? null, active: true,
        })) as Goal
      }
    },
    update: async (id: string, data: Partial<Goal>) => {
      try { return await req<Goal>(`/goals/${id}`, { method: 'PUT', body: JSON.stringify(data) }) } catch (error) {
        if (!isOfflineError(error)) throw error
        return queueOffline('goals', offlineRecord('goals', id, data as Record<string, unknown>)) as Goal
      }
    },
    remove: async (id: string) => {
      try { return await req(`/goals/${id}`, { method: 'DELETE' }) } catch (error) {
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
      return offlineList(async () => req<Memo[]>(`/memos?${q}`), 'memos').then((items) => items.filter((memo) => {
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
      try { return await req<Memo>('/memos', { method: 'POST', body: JSON.stringify(data) }) } catch (error) {
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
      try { return await req<Memo>(`/memos/${id}`, { method: 'PUT', body: JSON.stringify(data) }) } catch (error) {
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
      try { return await req(`/memos/${id}`, { method: 'DELETE' }) } catch (error) {
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
