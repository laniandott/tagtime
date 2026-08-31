import { useEffect, useRef } from 'react'
import { getServerHost } from '../api'

export type NoteEvent =
  | { type: 'note.created'; id: string; path: string; revision: number }
  | { type: 'note.updated'; id: string; path: string; revision: number }
  | { type: 'note.deleted'; id: string; path: string }
  | { type: 'note.renamed'; id: string; path: string }

// 监听笔记 WebSocket，断线自动重连（指数退避，上限 5s）
export function useNotesSocket(onEvent: (ev: NoteEvent) => void) {
  const cbRef = useRef(onEvent)
  cbRef.current = onEvent

  useEffect(() => {
    let ws: WebSocket | null = null
    let closed = false
    let retry = 0
    let timer: ReturnType<typeof setTimeout> | undefined

    const host = getServerHost()
    const scheme = host.startsWith('https')
      ? 'wss'
      : host.startsWith('http')
        ? 'ws'
        : window.location.protocol === 'https:'
          ? 'wss'
          : 'ws'
    const socketUrl = host
      ? `${scheme}://${host.replace(/^https?:\/\//, '')}/api/notes/ws`
      : `/api/notes/ws`

    const connect = () => {
      if (closed) return
      try {
        ws = new WebSocket(socketUrl)
      } catch {
        timer = setTimeout(connect, 1000)
        return
      }
      ws.onopen = () => { retry = 0 }
      ws.onmessage = (e) => {
        try {
          cbRef.current(JSON.parse(e.data as string))
        } catch { /* ignore malformed frame */ }
      }
      ws.onclose = () => {
        if (!closed) {
          retry = Math.min(retry + 1, 5)
          timer = setTimeout(connect, 1000 * retry)
        }
      }
      ws.onerror = () => { try { ws?.close() } catch { /* noop */ } }
    }
    connect()

    return () => {
      closed = true
      if (timer) clearTimeout(timer)
      try { ws?.close() } catch { /* noop */ }
    }
  }, [])
}