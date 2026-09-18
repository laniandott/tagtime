import { test } from 'node:test'
import assert from 'node:assert/strict'
import { api, DEFAULT_SERVER_HOST, getServerHost, normalizeServerHost, reqWithRetry, resolveUploadUrl } from '../src/api'
import { runSync } from '../src/sync'

const originalFetch = globalThis.fetch

function setFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = handler as typeof fetch
}

function installLocalStorage(): Map<string, string> {
  const values = new Map<string, string>()
  ;(globalThis as any).localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  }
  return values
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

test.afterEach(() => {
  globalThis.fetch = originalFetch
  ;(globalThis as any).localStorage?.clear?.()
})

test('GET 请求遇到网络错误会重试，最多三次', async () => {
  let attempts = 0
  setFetch(async () => {
    attempts++
    if (attempts < 3) throw new TypeError('fetch failed')
    return new Response('[]', { status: 200 })
  })

  const result = await reqWithRetry<unknown[]>('/test', { retryDelayMs: 0 })
  assert.deepEqual(result, [])
  assert.equal(attempts, 3)
})

test('GET 请求遇到 5xx 会重试，4xx 不会重试', async () => {
  let attempts = 0
  setFetch(async () => {
    attempts++
    if (attempts < 3) return new Response('{"error":"暂时不可用"}', { status: 503 })
    return new Response('{"error":"客户端错误"}', { status: 400 })
  })

  await assert.rejects(
    () => reqWithRetry('/test', { retryDelayMs: 0 }),
    (error: unknown) => error instanceof Error && error.message === '客户端错误',
  )
  assert.equal(attempts, 3)
})

test('POST 请求不会自动重试', async () => {
  let attempts = 0
  setFetch(async () => {
    attempts++
    throw new TypeError('fetch failed')
  })

  await assert.rejects(() => reqWithRetry('/test', {
    method: 'POST',
    body: '{}',
    retryDelayMs: 0,
  }))
  assert.equal(attempts, 1)
})

test('请求超时会中止，并且不会无限等待', async () => {
  setFetch(async (_input, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal
    const onAbort = () => reject(signal?.reason ?? new DOMException('请求超时', 'AbortError'))
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  }))

  await assert.rejects(
    () => reqWithRetry('/test', { timeout: 10, retryDelayMs: 0 }),
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
  )
})

test('附件地址拒绝危险协议，保留受支持的 HTTP 和同源路径', () => {
  assert.equal(resolveUploadUrl('javascript:alert(1)'), '')
  assert.equal(resolveUploadUrl('//evil.example/a.png'), '')
  assert.equal(resolveUploadUrl('/uploads/a.png'), '/uploads/a.png')
  assert.equal(resolveUploadUrl('https://example.com/a.png'), 'https://example.com/a.png')
})

test('服务器地址只接受安全的 HTTP(S) 地址', () => {
  assert.equal(normalizeServerHost('http://example.com/'), 'http://example.com')
  assert.equal(normalizeServerHost('https://example.com/tagtime///'), 'https://example.com/tagtime')
  assert.equal(normalizeServerHost('javascript:alert(1)'), '')
  assert.equal(normalizeServerHost('file:///tmp/tagtime'), '')
  assert.equal(normalizeServerHost('https://user:pass@example.com'), '')
  assert.equal(normalizeServerHost('https://example.com/?token=secret'), '')
})

test('旧版 App 服务器地址自动迁移到公网 HTTPS 入口', () => {
  const values = installLocalStorage()
  values.set('tagtime_server_url', 'http://812264226.xyz:3000')
  assert.equal(getServerHost(), DEFAULT_SERVER_HOST)
})

test('断网时分类先进入本地队列，列表可立即读回', async () => {
  const values = new Map<string, string>()
  ;(globalThis as any).localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  }
  setFetch(async () => { throw new TypeError('fetch failed') })

  const created = await api.categories.create({ name: '断网分类' })
  const listed = await api.categories.list()
  assert.equal(created.name, '断网分类')
  assert.equal(listed.some((item) => item.id === created.id && item.name === '断网分类'), true)
})

test('在线读取后重载仍优先显示本地数据', async () => {
  const values = new Map<string, string>()
  ;(globalThis as any).localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  }
  setFetch(async () => new Response(JSON.stringify([{ id: 'persisted-category', name: '本地可见', color: '#123456', icon: null, sortOrder: 0 }]), { status: 200 }))
  assert.equal((await api.categories.list())[0].name, '本地可见')
  setFetch(async () => { throw new TypeError('offline') })
  assert.equal((await api.categories.list())[0].id, 'persisted-category')
})

test('离线计时保留标签名称，且服务器 404 删除也会清理本地记录', async () => {
  const values = new Map<string, string>()
  ;(globalThis as any).localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  }
  setFetch(async () => { throw new TypeError('offline') })

  const tag = await api.tags.create({ name: '离线标签' })
  const entry = await api.timer.start({ tagId: tag.id })
  const listed = await api.timer.list()
  assert.equal(listed.find((item) => item.id === entry.id)?.tag?.name, '离线标签')

  setFetch(async (input, init) => {
    if (String(input).includes('/timer/') && init?.method === 'DELETE') return new Response('{"error":"不存在"}', { status: 404 })
    throw new TypeError('offline')
  })
  await api.timer.remove(entry.id)
  assert.equal((await api.timer.list()).some((item) => item.id === entry.id), false)
})

test('离线启动使用同一个客户端 ID，避免请求超时后生成重复记录', async () => {
  const values = new Map<string, string>()
  ;(globalThis as any).localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  }
  let requestId = ''
  setFetch(async (input, init) => {
    if (String(input).endsWith('/api/timer/start')) requestId = JSON.parse(String(init?.body)).id
    throw new TypeError('offline')
  })
  const created = await api.timer.start({ tagId: 'offline-tag' })
  assert.ok(requestId)
  assert.equal(created.id, requestId)
})

test('服务器当前计时为空时，本地不会永久保留过期的进行中记录', async () => {
  const values = installLocalStorage()
  values.set('tagtime.local.timeEntries', JSON.stringify([{
    id: 'stale-running', startTime: '2026-09-18T08:00:00.000Z', endTime: null, tagId: 'tag',
    pendingResume: false, dismissed: false,
  }]))
  setFetch(async (input) => {
    if (String(input).endsWith('/api/timer/current')) {
      return new Response(JSON.stringify({ running: [], serverTime: '2026-09-18T09:00:00.000Z' }), { status: 200 })
    }
    throw new TypeError('unexpected request')
  })

  assert.equal((await api.timer.current()).running.length, 1)
  await tick()
  assert.equal((await api.timer.current()).running.length, 0)
})

test('服务器已消费待续记录后，本地待续列表会清除旧状态', async () => {
  const values = installLocalStorage()
  values.set('tagtime.local.timeEntries', JSON.stringify([{
    id: 'stale-pending', startTime: '2026-09-18T08:00:00.000Z', endTime: '2026-09-18T08:30:00.000Z', tagId: 'tag',
    pendingResume: true, dismissed: false,
  }]))
  setFetch(async (input) => {
    if (String(input).endsWith('/api/timer/pending')) {
      return new Response(JSON.stringify({ pending: [], serverTime: '2026-09-18T09:00:00.000Z' }), { status: 200 })
    }
    throw new TypeError('unexpected request')
  })

  assert.equal((await api.timer.pending()).pending.length, 1)
  await tick()
  assert.equal((await api.timer.pending()).pending.length, 0)
})

test('离线续接会消费旧待续记录，不会生成两个待续状态', async () => {
  const values = installLocalStorage()
  values.set('tagtime.local.timeEntries', JSON.stringify([{
    id: 'parent', startTime: '2026-09-18T08:00:00.000Z', endTime: '2026-09-18T08:30:00.000Z', tagId: 'tag',
    pendingResume: true, dismissed: false, note: '继续处理',
  }]))
  setFetch(async () => { throw new TypeError('offline') })

  const child = await api.timer.start({ tagId: 'tag', resumedFromId: 'parent' })
  assert.equal(child.resumedFromId, 'parent')
  assert.equal((await api.timer.pending()).pending.length, 0)
})

test('同步请求期间的新本地修改不会被旧服务器快照覆盖', async () => {
  const values = installLocalStorage()
  values.set('tagtime_server_url', 'http://sync.test')
  const original = { id: 'local-entry', startTime: '2026-09-18T08:00:00.000Z', endTime: null, tagId: 'tag', note: '旧', pendingResume: false, dismissed: false }
  const changed = { ...original, note: '新' }
  values.set('tagtime.sync.pending', JSON.stringify({ categories: [], tags: [], goals: [], todos: [], timeEntries: [original], memos: [] }))
  let releasePost!: () => void
  let postStarted!: () => void
  const postEntered = new Promise<void>((resolve) => { postStarted = resolve })
  const postGate = new Promise<void>((resolve) => { releasePost = resolve })
  setFetch(async (input, init) => {
    if (String(input).endsWith('/api/sync') && (init?.method ?? 'GET') === 'GET') {
      return new Response(JSON.stringify({ cursor: 1, categories: [], tags: [], goals: [], todos: [], timeEntries: [], memos: [] }), { status: 200 })
    }
    if (String(input).endsWith('/api/sync') && init?.method === 'POST') {
      postStarted()
      await postGate
      return new Response(JSON.stringify({ cursor: 2, categories: [], tags: [], goals: [], todos: [], timeEntries: [], memos: [] }), { status: 200 })
    }
    throw new TypeError('unexpected request')
  })

  const syncing = runSync()
  await postEntered
  values.set('tagtime.sync.pending', JSON.stringify({ categories: [], tags: [], goals: [], todos: [], timeEntries: [changed], memos: [] }))
  releasePost()
  assert.equal(await syncing, true)
  const local = JSON.parse(values.get('tagtime.local.timeEntries') ?? '[]')
  assert.equal(local.find((item: any) => item.id === 'local-entry')?.note, '新')
})
