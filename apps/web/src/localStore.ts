export type LocalBucket = 'categories' | 'tags' | 'goals' | 'todos' | 'timeEntries' | 'memos'

const PREFIX = 'tagtime.local.'

function key(bucket: LocalBucket): string {
  return `${PREFIX}${bucket}`
}

export function loadLocalBucket<T extends { id: string }>(bucket: LocalBucket): T[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const parsed = JSON.parse(localStorage.getItem(key(bucket)) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.id === 'string') as T[] : []
  } catch {
    return []
  }
}

export function saveLocalBucket<T extends { id: string }>(bucket: LocalBucket, items: T[]): void {
  if (typeof localStorage === 'undefined') return
  try { localStorage.setItem(key(bucket), JSON.stringify(items)) } catch { /* best effort */ }
}

export function saveLocalRecord(bucket: LocalBucket, item: { id: string; deleted?: boolean }): void {
  const items = loadLocalBucket<Record<string, unknown> & { id: string }>(bucket)
  const next = items.filter((current) => current.id !== item.id)
  if (!item.deleted) next.push(item as Record<string, unknown> & { id: string })
  saveLocalBucket(bucket, next)
}

export function saveLocalSnapshot(snapshot: Partial<Record<LocalBucket, unknown>>): void {
  for (const bucket of ['categories', 'tags', 'goals', 'todos', 'timeEntries', 'memos'] as const) {
    if (Array.isArray(snapshot[bucket])) saveLocalBucket(bucket, snapshot[bucket] as { id: string }[])
  }
}
