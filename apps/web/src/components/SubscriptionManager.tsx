import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '../api'
import type { CalendarSubscription } from '../types'

const PRESET_COLORS = ['#e74c3c', '#e67e22', '#f1c40f', '#2ecc71', '#3498db', '#9b59b6', '#1abc9c', '#e84393']

export function SubscriptionManager({ onClose }: { onClose: () => void }) {
  const [subs, setSubs] = useState<CalendarSubscription[]>([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [newName, setNewName] = useState('')
  const [newUrl, setNewUrl] = useState('')
  const [newColor, setNewColor] = useState(PRESET_COLORS[0])
  const [error, setError] = useState('')
  const loadSequence = useRef(0)

  const loadSubs = useCallback(async () => {
    const sequence = ++loadSequence.current
    setLoading(true)
    try {
      const result = await api.calendars.subscriptions.list()
      if (sequence !== loadSequence.current) return
      setSubs(result)
      setError('')
    } catch (err) {
      if (sequence !== loadSequence.current) return
      // 保留旧列表，避免临时网络错误被误显示成“暂无订阅”。
      setError(err instanceof Error ? err.message : '加载订阅失败')
    }
    finally {
      if (sequence === loadSequence.current) setLoading(false)
    }
  }, [])

  useEffect(() => { loadSubs() }, [loadSubs])

  const addSub = async () => {
    if (!newName.trim() || !newUrl.trim()) { setError('请填写名称和 URL'); return }
    setError('')
    try {
      await api.calendars.subscriptions.create({ name: newName.trim(), url: newUrl.trim(), color: newColor })
      setNewName(''); setNewUrl(''); setShowAdd(false)
      loadSubs()
    } catch (err) { setError((err as Error).message) }
  }

  const syncSub = async (id: string) => {
    setSyncing(id)
    setError('')
    try {
      await api.calendars.subscriptions.sync(id)
      await loadSubs()
    } catch (err) {
      setError(err instanceof Error ? err.message : '同步订阅失败')
    }
    finally { setSyncing(null) }
  }

  const deleteSub = async (id: string, name: string) => {
    if (!confirm(`确定删除订阅「${name}」？`)) return
    setError('')
    try {
      await api.calendars.subscriptions.remove(id)
      await loadSubs()
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除订阅失败')
    }
  }

  const formatTimeAgo = (dateStr: string | null) => {
    if (!dateStr) return '从未同步'
    const diff = Date.now() - new Date(dateStr).getTime()
    const mins = Math.floor(diff / 60000)
    if (mins < 1) return '刚刚'
    if (mins < 60) return `${mins} 分钟前`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `${hours} 小时前`
    const days = Math.floor(hours / 24)
    return `${days} 天前`
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 rounded-2xl p-6 w-full max-w-lg mx-4 shadow-xl max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold">📡 日历订阅</h3>
          <button onClick={onClose} className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400 transition-colors">✕</button>
        </div>

        {error && <div className="mb-3 text-xs text-red-500">{error}</div>}

        {/* 已有订阅列表 */}
        <div className="flex-1 overflow-y-auto space-y-2 mb-4">
          {loading ? (
            <div className="text-center py-6 text-gray-400 text-sm">加载中…</div>
          ) : subs.length === 0 ? (
            <div className="text-center py-6 text-gray-400 text-sm">暂无订阅，点击下方添加</div>
          ) : (
            subs.map((sub) => (
              <div key={sub.id} className="flex items-center gap-3 p-3 rounded-xl border border-gray-200 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors group">
                <span className="w-4 h-4 rounded-full flex-shrink-0" style={{ background: sub.color }} />
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm truncate">{sub.name}</div>
                  <div className="text-[10px] text-gray-400 truncate">{sub.url}</div>
                  <div className="text-[10px] text-gray-400">最后同步: {formatTimeAgo(sub.lastSyncAt)}</div>
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => syncSub(sub.id)}
                    disabled={syncing === sub.id}
                    className="px-2 py-1 text-[10px] rounded-lg bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
                  >
                    {syncing === sub.id ? '同步中…' : '🔄 同步'}
                  </button>
                  <button
                    onClick={() => deleteSub(sub.id, sub.name)}
                    className="px-2 py-1 text-[10px] rounded-lg text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                  >
                    删除
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* 添加新订阅 */}
        {showAdd ? (
          <div className="border-t border-gray-200 dark:border-gray-800 pt-4 space-y-3">
            <div className="text-sm font-semibold text-gray-700 dark:text-gray-200">添加新订阅</div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">名称</label>
              <input
                type="text" value={newName} onChange={(e) => setNewName(e.target.value)}
                placeholder="例如：中国节假日"
                className="input text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">ICS URL</label>
              <input
                type="url" value={newUrl} onChange={(e) => setNewUrl(e.target.value)}
                placeholder="https://example.com/calendar.ics"
                className="input text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">颜色</label>
              <div className="flex gap-2">
                {PRESET_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setNewColor(c)}
                    className={`w-7 h-7 rounded-full transition-all ${newColor === c ? 'ring-2 ring-offset-2 ring-offset-white dark:ring-offset-gray-900 scale-110' : 'hover:scale-105'}`}
                    style={{ backgroundColor: c, ...(newColor === c ? { boxShadow: `0 0 0 2px white, 0 0 0 4px ${c}` } : {}) }}
                  />
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => { setShowAdd(false); setError('') }} className="px-3 py-1.5 rounded-lg text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800">取消</button>
              <button onClick={addSub} className="px-4 py-1.5 rounded-lg text-sm bg-brand text-white hover:bg-brand-600 font-medium">保存</button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setShowAdd(true)}
            className="w-full py-2.5 rounded-xl text-sm font-medium border-2 border-dashed border-gray-300 dark:border-gray-700 text-gray-500 hover:border-brand hover:text-brand transition-colors"
          >
            + 添加新订阅
          </button>
        )}
      </div>
    </div>
  )
}
