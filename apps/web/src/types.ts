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
  sortOrder: number
  category?: Category | null
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
