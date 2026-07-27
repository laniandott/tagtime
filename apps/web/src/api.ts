import type {
  Category,
  Tag,
  TimeEntry,
  Todo,
  Summary,
  DailyStat,
  TagStat,
} from './types'

const BASE = '/api'

async function req<T>(path: string, opts?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {}
  // 仅对有 body 的请求设置 Content-Type，避免 Fastify 拒绝空 JSON body（如 DELETE）
  if (opts?.body) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { ...headers, ...(opts?.headers as Record<string, string> | undefined) },
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error ?? '请求失败')
  }
  // 部分接口（如 DELETE）可能无响应体
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
    list: (params?: { from?: string; to?: string; tagId?: string }) => {
      const q = new URLSearchParams()
      if (params?.from) q.set('from', params.from)
      if (params?.to) q.set('to', params.to)
      if (params?.tagId) q.set('tagId', params.tagId)
      return req<TimeEntry[]>(`/timer?${q}`)
    },
    remove: (id: string) => req(`/timer/${id}`, { method: 'DELETE' }),
    manual: (data: { tagId: string; startTime: string; endTime: string; note?: string }) =>
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
    daily: (days = 7, categoryId?: string) => {
      const q = new URLSearchParams()
      q.set('days', String(days))
      if (categoryId) q.set('categoryId', categoryId)
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
    byCategory: (from?: string, to?: string) =>
      req<TagStat[]>(`/stats/by-category${from ? `?from=${from}&to=${to ?? ''}` : ''}`),
  },
}
