import type {
  Category,
  Tag,
  TimeEntry,
  Todo,
  Summary,
  DailyStat,
  TagStat,
  Goal,
  Memo,
  CalendarSubscription,
  CalendarEvent,
  NoteListEntry,
  NoteDetail,
  NoteAutocompleteEntry,
  GraphData,
  RelatedEntities,
  EntityLinkType,
  LinkedNoteEntry,
} from './types'

export function getServerHost(): string {
  if (typeof localStorage !== 'undefined') {
    const custom = localStorage.getItem('tagtime_server_url')
    if (custom) return custom.replace(/\/$/, '')
  }
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

export function resolveUploadUrl(path?: string | null): string {
  if (!path) return ''
  if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('data:')) {
    return path
  }
  const host = getServerHost()
  const cleanPath = path.startsWith('/') ? path : `/${path}`
  return `${host}${cleanPath}`
}

export function setServerHost(url: string) {
  if (typeof localStorage !== 'undefined') {
    if (url.trim()) {
      localStorage.setItem('tagtime_server_url', url.trim().replace(/\/$/, ''))
    } else {
      localStorage.removeItem('tagtime_server_url')
    }
  }
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

async function req<T>(path: string, opts?: RequestInit): Promise<T> {
  const host = getServerHost()
  const headers: Record<string, string> = {}
  if (opts?.body) headers['Content-Type'] = 'application/json'
  const url = `${host}/api${path}`
  const res = await fetch(url, {
    ...opts,
    headers: { ...headers, ...(opts?.headers as Record<string, string> | undefined) },
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new ApiError(err.error ?? '请求失败', res.status, err)
  }
  const text = await res.text()
  return (text ? JSON.parse(text) : null) as T
}

// 分类
export const api = {
  categories: {
    list: () => req<Category[]>('/categories'),
    create: (data: Partial<Category>) =>
      req<Category>('/categories', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<Category>) =>
      req<Category>(`/categories/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    remove: (id: string) => req(`/categories/${id}`, { method: 'DELETE' }),
  },
  tags: {
    list: () => req<Tag[]>('/tags'),
    create: (data: Partial<Tag> & { name: string }) =>
      req<Tag>('/tags', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<Tag>) =>
      req<Tag>(`/tags/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    remove: (id: string) => req(`/tags/${id}`, { method: 'DELETE' }),
  },
  timer: {
    current: () => req<{ running: TimeEntry[]; serverTime: string }>('/timer/current'),
    start: (data: { tagId: string; note?: string; todoId?: string }) =>
      req<TimeEntry & { serverTime: string }>('/timer/start', { method: 'POST', body: JSON.stringify(data) }),
    stop: (id: string, note?: string) =>
      req<TimeEntry>(`/timer/stop/${id}`, { method: 'POST', body: JSON.stringify({ note }) }),
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
    remove: (id: string) => req(`/timer/${id}`, { method: 'DELETE' }),
    manual: (data: { tagId: string; startTime: string; endTime: string; note?: string; todoId?: string }) =>
      req<TimeEntry>('/timer/manual', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: { startTime?: string; endTime?: string | null; note?: string; tagId?: string }) =>
      req<TimeEntry>(`/timer/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  },
  todos: {
    list: (params?: { status?: string; categoryId?: string }) => {
      const q = new URLSearchParams()
      if (params?.status) q.set('status', params.status)
      if (params?.categoryId) q.set('categoryId', params.categoryId)
      return req<Todo[]>(`/todos?${q}`)
    },
    create: (data: Partial<Todo> & { title: string }) =>
      req<Todo>('/todos', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<Todo>) =>
      req<Todo>(`/todos/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    toggle: (id: string) =>
      req<Todo>(`/todos/${id}/toggle`, { method: 'PATCH' }),
    remove: (id: string) => req(`/todos/${id}`, { method: 'DELETE' }),
  },
  stats: {
    summary: (categoryId?: string) =>
      req<Summary>(`/stats/summary${categoryId ? `?categoryId=${categoryId}` : ''}`),
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
  },
  goals: {
    list: () => req<Goal[]>('/goals'),
    create: (data: { tagId: string; title: string; type?: string; target?: number; period?: string; periodDays?: number | null }) =>
      req<Goal>('/goals', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<Goal>) =>
      req<Goal>(`/goals/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    remove: (id: string) => req(`/goals/${id}`, { method: 'DELETE' }),
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
      return req<Memo[]>(`/memos?${q}`)
    },
    create: (data: {
      content: string
      type?: 'point' | 'diary'
      timeEntryId?: string
      tagId?: string
      createdAt?: string
      attachments?: { filename: string; path: string; mimeType: string; size: number }[]
    }) => req<Memo>('/memos', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: {
      content?: string
      createdAt?: string
      attachments?: { filename: string; path: string; mimeType: string; size: number }[]
    }) => req<Memo>(`/memos/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    upload: async (file: File) => {
      const host = getServerHost()
      const form = new FormData()
      form.append('file', file, file.name || 'upload.bin')
      const request = (url: string) => fetch(url, { method: 'POST', body: form })
      let res: Response
      try {
        res = await request(`${host}/api/memos/upload`)
      } catch (firstError) {
        // HTTPS pages cannot call a stale HTTP server URL; retry through same origin.
        if (typeof window !== 'undefined' && window.location.protocol === 'https:' && host) {
          res = await request('/api/memos/upload')
        } else {
          throw firstError
        }
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `${res.status} ${res.statusText}` }))
        throw new Error(err.error ?? `上传文件失败 (${res.status})`)
      }
      return res.json() as Promise<{ filename: string; path: string; mimeType: string; size: number }>
    },
    remove: (id: string) => req(`/memos/${id}`, { method: 'DELETE' }),
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
    list: (q?: string) => {
      const qs = q ? `?q=${encodeURIComponent(q)}` : ''
      return req<NoteListEntry[]>(`/notes${qs}`)
    },
    get: (id: string) => req<NoteDetail>(`/notes/${id}`),
    create: (data: { title: string; content?: string }) =>
      req<{ id: string; path: string; revision: number }>('/notes', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: { content: string; revision: number }) =>
      req<{ id: string; path: string; revision: number }>(`/notes/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    rename: (id: string, data: { title: string }) =>
      req<{ id: string; path: string; title: string }>(`/notes/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
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
