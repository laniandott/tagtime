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

export function saveLocalRecord<T extends { id: string }>(bucket: LocalBucket, item: T & { deleted?: boolean }): void {
  const items = loadLocalBucket<{ id: string }>(bucket)
  const next = items.filter((current) => current.id !== item.id)
  if (!item.deleted) next.push(item)
  saveLocalBucket(bucket, next)
}

export function saveLocalSnapshot(
  snapshot: Partial<Record<LocalBucket, unknown>>,
  overlay: Partial<Record<LocalBucket, unknown[]>> = {},
): void {
  for (const bucket of ['categories', 'tags', 'goals', 'todos', 'timeEntries', 'memos'] as const) {
    if (!Array.isArray(snapshot[bucket])) continue
    saveLocalBucket(bucket, snapshot[bucket] as { id: string }[])
    for (const item of overlay[bucket] ?? []) {
      if (item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string') {
        saveLocalRecord(bucket, item as { id: string; deleted?: boolean })
      }
    }
  }
}
