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

let notificationListenerRegistered = false

// 安卓原生通知栏同步（仅在 Capacitor 原生 App 环境下按需动态加载并执行）
async function syncNativeNotification(running: TimeEntry[]) {
  try {
    const isCapacitor = typeof window !== 'undefined' && Boolean((window as any).Capacitor?.isNativePlatform?.())
    if (!isCapacitor) return

    const { LocalNotifications } = await import('@capacitor/local-notifications')

    // 注册点击通知事件监听，确保点击通知切回 App 时重新保持常驻通知栏
    if (!notificationListenerRegistered) {
      notificationListenerRegistered = true
      LocalNotifications.addListener('localNotificationActionPerformed', async () => {
        const currentRunning = useStore.getState().running
        if (currentRunning.length > 0) {
          syncNativeNotification(currentRunning)
        }
      }).catch(() => {})
    }

    const perm = await LocalNotifications.checkPermissions()
    if (perm.display !== 'granted') {
      await LocalNotifications.requestPermissions()
    }

    if (running.length > 0) {
      const active = running[0]
      const tagName = active.tag?.name ? `${active.tag.icon ? active.tag.icon + ' ' : ''}${active.tag.name}` : '活动'
      await LocalNotifications.schedule({
        notifications: [
          {
            id: 1001,
            title: `⏱ 正在计时 · ${tagName}`,
            body: `开始于 ${new Date(active.startTime).toLocaleTimeString('zh-CN', { hour12: false })} · 点击切回 TagTime`,
            ongoing: true,
            autoCancel: false,
          },
        ],
      })
    } else {
      await LocalNotifications.cancel({ notifications: [{ id: 1001 }] })
    }
  } catch (e) {
    console.warn('Native notification sync warn:', e)
  }
}

// 页面重新获得焦点（如从通知栏切回 App）时自动刷新计时与常驻通知
if (typeof window !== 'undefined') {
  window.addEventListener('focus', () => {
    useStore.getState().loadRunning()
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      useStore.getState().loadRunning()
    }
  })
}

export const useStore = create<AppState>((set, get) => ({
  categories: [],
  tags: [],
  running: [],
  clockOffset: 0,
  loading: false,

  loadAll: async () => {
    set({ loading: true })
    try {
      const [categories, tags, timerData] = await Promise.all([
        api.categories.list().catch(() => []),
        api.tags.list().catch(() => []),
        api.timer.current().catch(() => ({ running: [], serverTime: new Date().toISOString() })),
      ])
      const categoriesList = Array.isArray(categories) ? categories : []
      const tagsList = Array.isArray(tags) ? tags : []
      const runningList = Array.isArray(timerData?.running) ? timerData.running : []
      const clockOffset = timerData?.serverTime ? Date.now() - new Date(timerData.serverTime).getTime() : 0

      set({ categories: categoriesList, tags: tagsList, running: runningList, clockOffset, loading: false })
      syncNativeNotification(runningList)
    } catch (e) {
      console.error('loadAll error:', e)
      set({ loading: false })
    }
  },

  loadRunning: async () => {
    try {
      const timerData = await api.timer.current().catch(() => ({ running: [], serverTime: new Date().toISOString() }))
      const runningList = Array.isArray(timerData?.running) ? timerData.running : []
      const clockOffset = timerData?.serverTime ? Date.now() - new Date(timerData.serverTime).getTime() : 0
      set({ running: runningList, clockOffset })
      syncNativeNotification(runningList)
    } catch (e) {
      console.error('loadRunning error:', e)
    }
  },

  start: async (tagId, note, todoId) => {
    const res = await api.timer.start({ tagId, note, todoId })
    const { serverTime, ...entry } = res
    const clockOffset = Date.now() - new Date(serverTime).getTime()
    const newRunning = [...get().running, entry]
    set({ running: newRunning, clockOffset })
    syncNativeNotification(newRunning)
  },

  stop: async (id, note) => {
    await api.timer.stop(id, note)
    const newRunning = get().running.filter((e) => e.id !== id)
    set({ running: newRunning })
    syncNativeNotification(newRunning)
    await get().loadAll()
  },

  stopAll: async () => {
    await api.timer.stopAll()
    set({ running: [] })
    syncNativeNotification([])
    await get().loadAll()
  },

  quickCount: async (tagId, note, todoId) => {
    await api.timer.quick({ tagId, note, todoId })
    await get().loadAll()
  },
}))

// 安全转 ISO 字符串（无效输入返回 null，避免 toISOString 抛 RangeError 白屏）
export function toIsoSafe(v: string): string | null {
  const t = new Date(v)
  return isNaN(t.getTime()) ? null : t.toISOString()
}

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
