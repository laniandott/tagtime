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
  createdAt: string
  updatedAt: string
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
  tag?: Tag | null
  current?: number
  periodStart?: string
  percent?: number
}

export interface CalendarSubscription {
  id: string
  name: string
  url: string
  color: string
  active: boolean
  lastSyncAt: string | null
  createdAt: string
  updatedAt: string
}

export interface CalendarEvent {
  id: string
  subscriptionId: string
  uid: string
  summary: string
  description: string | null
  location: string | null
  dtstart: string
  dtend: string | null
  allday: boolean
  rrule: string | null
  subscription?: { name: string; color: string }
}

export interface NoteListEntry {
  id: string
  path: string
  title: string
  revision: number
  createdAt: string
  updatedAt: string
  outLinkCount: number
  inLinkCount: number
}

export interface NoteOutLink {
  id: string
  targetNoteId: string | null
  targetTitle: string
  linkText: string
  isResolved: boolean
}

export interface NoteInLink {
  sourceNoteId: string
  sourceTitle: string
  isResolved: boolean
}

export interface NoteDetail {
  id: string
  path: string
  title: string
  revision: number
  createdAt: string
  updatedAt: string
  content: string
  outLinks: NoteOutLink[]
  inLinks: NoteInLink[]
}

export interface NoteAutocompleteEntry {
  id: string
  title: string
  path: string
}

export interface GraphNode {
  id: string
  title: string
  path: string | null
  isCurrent?: boolean
  isUnresolved?: boolean
  level?: number
}

export interface GraphLink {
  source: string
  target: string
  resolved: boolean
}

export interface GraphData {
  root: string | null
  nodes: GraphNode[]
  links: GraphLink[]
  truncated?: boolean
}

export type EntityLinkType = 'tag' | 'todo' | 'date' | 'memo'

export interface RelatedEntity {
  type: EntityLinkType
  entityKey: string
  linkText: string
  resolved: boolean
  name?: string
}

export interface RelatedEntities {
  tags: RelatedEntity[]
  todos: RelatedEntity[]
  memos: RelatedEntity[]
  dates: RelatedEntity[]
}

export interface LinkedNoteEntry {
  id: string
  title: string
  path: string
  revision: number
  updatedAt: string
}
