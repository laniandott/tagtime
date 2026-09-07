import { create } from 'zustand'
import type { Category, Tag, TimeEntry } from './types'
import { api } from './api'

interface AppState {
  categories: Category[]
  tags: Tag[]
  running: TimeEntry[]
  pending: TimeEntry[]
  clockOffset: number // 浏览器时钟 - 服务器时钟（毫秒），用于修正容器时钟偏差
  loading: boolean
  // 加载基础数据
  loadAll: () => Promise<void>
  loadRunning: () => Promise<void>
  loadPending: () => Promise<void>
  // 计时操作
  start: (tagId: string, note?: string, todoId?: string, interruptedFromId?: string) => Promise<void>
  stop: (id: string, note?: string, pendingResume?: boolean) => Promise<TimeEntry>
  stopAll: () => Promise<void>
  // 续接操作
  resumeEntry: (pendingId: string, note?: string) => Promise<void>
  dismissPending: (id: string, reason: string) => Promise<void>
  finishPending: (id: string) => Promise<void>
  terminateChain: (id: string, reason: string) => Promise<{ count: number }>
  // 次数型打卡
  quickCount: (tagId: string, note?: string, todoId?: string) => Promise<void>
}

let notificationListenerRegistered = false
let loadAllRequestSequence = 0
let runningRequestSequence = 0

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
  pending: [],
  clockOffset: 0,
  loading: false,

  loadAll: async () => {
    const requestSequence = ++loadAllRequestSequence
    const runningSequenceAtStart = runningRequestSequence
    set({ loading: true })
    try {
      const [categoriesResult, tagsResult, timerResult, pendingResult] = await Promise.allSettled([
        api.categories.list(),
        api.tags.list(),
        api.timer.current(),
        api.timer.pending(),
      ])
      // 仅取消更早的 loadAll；loadRunning 的刷新不应让全局 loading 永久卡住。
      if (requestSequence !== loadAllRequestSequence) return

      const current = get()
      const categoriesList = categoriesResult.status === 'fulfilled' && Array.isArray(categoriesResult.value)
        ? categoriesResult.value
        : current.categories
      const tagsList = tagsResult.status === 'fulfilled' && Array.isArray(tagsResult.value)
        ? tagsResult.value
        : current.tags
      const timerData = timerResult.status === 'fulfilled' ? timerResult.value : null
      const pendingData = pendingResult.status === 'fulfilled' ? pendingResult.value : null
      // 若期间已有更晚的 loadRunning，保留它的结果，避免旧的 loadAll 覆盖新计时状态。
      const runningList = runningSequenceAtStart === runningRequestSequence && timerData && Array.isArray(timerData.running)
        ? timerData.running
        : current.running
      const pendingList = pendingData && Array.isArray(pendingData.pending) ? pendingData.pending : current.pending
      const serverMs = timerData?.serverTime ? new Date(timerData.serverTime).getTime() : NaN
      const clockOffset = Number.isFinite(serverMs) ? Date.now() - serverMs : current.clockOffset

      set({ categories: categoriesList, tags: tagsList, running: runningList, pending: pendingList, clockOffset, loading: false })
      syncNativeNotification(runningList)
    } catch (e) {
      console.error('loadAll error:', e)
      if (requestSequence === loadAllRequestSequence) set({ loading: false })
    }
  },

  loadRunning: async () => {
    const requestSequence = ++runningRequestSequence
    try {
      const timerData = await api.timer.current()
      if (requestSequence !== runningRequestSequence) return
      const current = get()
      const runningList = Array.isArray(timerData?.running) ? timerData.running : current.running
      const serverMs = timerData?.serverTime ? new Date(timerData.serverTime).getTime() : NaN
      const clockOffset = Number.isFinite(serverMs) ? Date.now() - serverMs : current.clockOffset
      set({ running: runningList, clockOffset })
      syncNativeNotification(runningList)
    } catch (e) {
      console.error('loadRunning error:', e)
    }
  },

  loadPending: async () => {
    try {
      const data = await api.timer.pending()
      const pendingList = Array.isArray(data?.pending) ? data.pending : []
      set({ pending: pendingList })
    } catch (e) {
      console.error('loadPending error:', e)
    }
  },

  start: async (tagId, note, todoId, interruptedFromId) => {
    const res = await api.timer.start({ tagId, note, todoId, interruptedFromId })
    const { serverTime, ...entry } = res
    const clockOffset = Date.now() - new Date(serverTime).getTime()
    const newRunning = [...get().running, entry]
    set({ running: newRunning, clockOffset })
    syncNativeNotification(newRunning)
    await get().loadPending()
  },

  stop: async (id, note, pendingResume) => {
    const stopped = await api.timer.stop(id, note, pendingResume)
    const newRunning = get().running.filter((e) => e.id !== id)
    set({ running: newRunning })
    syncNativeNotification(newRunning)
    await get().loadPending()
    await get().loadAll()
    return stopped
  },

  stopAll: async () => {
    await api.timer.stopAll()
    set({ running: [] })
    syncNativeNotification([])
    await get().loadPending()
    await get().loadAll()
  },

  resumeEntry: async (pendingId, note) => {
    const pendingEntry = get().pending.find(e => e.id === pendingId)
    if (!pendingEntry) throw new Error('待续记录不存在')
    const res = await api.timer.start({
      tagId: pendingEntry.tagId,
      note: note ?? pendingEntry.note ?? undefined,
      todoId: pendingEntry.todoId ?? undefined,
      resumedFromId: pendingId,
    })
    const { serverTime, ...entry } = res
    const clockOffset = Date.now() - new Date(serverTime).getTime()
    const newRunning = [...get().running, entry]
    set({ running: newRunning, clockOffset })
    syncNativeNotification(newRunning)
    await get().loadPending()
  },

  dismissPending: async (id, reason) => {
    await api.timer.dismissPending(id, reason)
    await get().loadPending()
  },

  finishPending: async (id) => {
    await api.timer.finishPending(id)
    await get().loadPending()
  },

  terminateChain: async (id, reason) => {
    const result = await api.timer.terminateChain(id, reason)
    await get().loadAll()
    return result
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
