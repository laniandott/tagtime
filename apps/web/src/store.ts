import { create } from 'zustand'
import type { Category, Tag, TimeEntry } from './types'
import { api } from './api'

interface AppState {
  categories: Category[]
  tags: Tag[]
  running: TimeEntry[]
  clockOffset: number // 浏览器时钟 - 服务器时钟（毫秒），用于修正容器时钟偏差
  loading: boolean
  // 加载基础数据
  loadAll: () => Promise<void>
  loadRunning: () => Promise<void>
  // 计时操作
  start: (tagId: string, note?: string, todoId?: string) => Promise<void>
  stop: (id: string, note?: string) => Promise<void>
  stopAll: () => Promise<void>
  // 次数型打卡
  quickCount: (tagId: string, note?: string, todoId?: string) => Promise<void>
}

export const useStore = create<AppState>((set, get) => ({
  categories: [],
  tags: [],
  running: [],
  clockOffset: 0,
  loading: false,

  loadAll: async () => {
    set({ loading: true })
    const [categories, tags, timerData] = await Promise.all([
      api.categories.list(),
      api.tags.list(),
      api.timer.current(),
    ])
    const clockOffset = Date.now() - new Date(timerData.serverTime).getTime()
    set({ categories, tags, running: timerData.running, clockOffset, loading: false })
  },

  loadRunning: async () => {
    const timerData = await api.timer.current()
    const clockOffset = Date.now() - new Date(timerData.serverTime).getTime()
    set({ running: timerData.running, clockOffset })
  },

  start: async (tagId, note, todoId) => {
    const res = await api.timer.start({ tagId, note, todoId })
    const { serverTime, ...entry } = res
    const clockOffset = Date.now() - new Date(serverTime).getTime()
    set({ running: [...get().running, entry], clockOffset })
  },

  stop: async (id, note) => {
    await api.timer.stop(id, note)
    set({ running: get().running.filter((e) => e.id !== id) })
    // 刷新数据
    await get().loadAll()
  },

  stopAll: async () => {
    await api.timer.stopAll()
    set({ running: [] })
    await get().loadAll()
  },

  quickCount: async (tagId, note, todoId) => {
    await api.timer.quick({ tagId, note, todoId })
    // 次数型打卡不需要加入 running，但需要刷新数据
    await get().loadAll()
  },
}))

// 格式化时长（毫秒 -> "1h 23m" / "23m 5s" / "5s"）
export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

// 格式化时长（毫秒 -> "1:23:05"）
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return [h, m, sec].map((n) => String(n).padStart(2, '0')).join(':')
}
