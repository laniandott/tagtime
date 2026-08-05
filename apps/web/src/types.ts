// 共享类型定义

export interface Category {
  id: string
  name: string
  color: string
  icon: string | null
  sortOrder: number
  _count?: { tags: number }
}

export interface Tag {
  id: string
  name: string
  color: string
  icon: string | null
  categoryId: string | null
  trackType: 'time' | 'count'
  sortOrder: number
  category?: Category | null
}

export interface Attachment {
  id: string
  memoId: string
  filename: string
  path: string
  mimeType: string
  size: number
  createdAt: string
}

export interface Memo {
  id: string
  content: string
  type?: 'point' | 'diary'
  timeEntryId: string | null
  tagId: string | null
  createdAt: string
  updatedAt: string
  attachments?: Attachment[]
  tag?: Tag | null
  timeEntry?: TimeEntry | null
}

export interface TimeEntry {
  id: string
  startTime: string
  endTime: string | null
  note: string | null
  tagId: string
  todoId: string | null
  tag?: Tag | null
  todo?: Todo | null
  memos?: Memo[]
}

export interface Todo {
  id: string
  title: string
  description: string | null
  status: 'pending' | 'done'
  priority: number
  dueDate: string | null
  categoryId: string | null
  category?: Category | null
  _count?: { timeEntries: number }
}

export interface Summary {
  today: number
  week: number
  month: number
  todayByCategory: { name: string; color: string; ms: number }[]
}

export interface DailyStat {
  date: string
  total: number
  byCategory: { name: string; color: string; ms: number }[]
}

export interface TagStat {
  tagId: string
  tagName: string
  color: string
  category: string | null
  ms: number
}

export interface Goal {
  id: string
  tagId: string
  title: string
  type: 'time' | 'count'
  target: number
  period: 'daily' | 'weekly' | 'monthly' | 'custom'
  periodDays: number | null
  active: boolean
  createdAt: string
  updatedAt: string
  // 以下为 /goals 接口返回的进度字段
  tag?: Tag | null
  current?: number
  periodStart?: string
  percent?: number
}
