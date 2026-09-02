import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeServerHost, reqWithRetry, resolveUploadUrl } from '../src/api'

const originalFetch = globalThis.fetch

function setFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = handler as typeof fetch
}

test.afterEach(() => {
  globalThis.fetch = originalFetch
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
