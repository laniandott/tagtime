import { useState } from 'react'
import { getServerHost } from '../api'
import { useStore } from '../store'

export function CalendarSyncModal({ onClose }: { onClose: () => void }) {
  const { categories } = useStore()
  const [days, setDays] = useState<'30' | '90' | 'all'>('90')
  const [selectedCat, setSelectedCat] = useState<string>('')
  const [copiedType, setCopiedType] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'apple' | 'android' | 'google' | 'outlook'>('apple')

  // 计算完整的绝对服务器根地址
  const getBaseUrl = () => {
    const host = getServerHost()
    if (host) return host
    if (typeof window !== 'undefined') {
      return `${window.location.protocol}//${window.location.host}`
    }
    return 'http://812264226.xyz:3000'
  }

  // 构建带过滤参数的查询串
  const buildQuery = () => {
    const params = new URLSearchParams()
    if (days === 'all') {
      params.set('all', 'true')
    } else {
      params.set('days', days)
    }
    if (selectedCat) {
      params.set('categoryId', selectedCat)
    }
    const q = params.toString()
    return q ? `?${q}` : ''
  }

  const baseUrl = getBaseUrl()
  const queryStr = buildQuery()
  const httpUrl = `${baseUrl}/api/calendar/feed.ics${queryStr}`
  const webcalUrl = `${baseUrl.replace(/^https?:\/\//i, 'webcal://')}/api/calendar/feed.ics${queryStr}`

  const copyToClipboard = async (text: string, type: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedType(type)
      setTimeout(() => setCopiedType(null), 2000)
    } catch {
      // 降级使用 prompt
      window.prompt('请手动复制以下日历订阅链接：', text)
    }
  }

  const downloadIcs = () => {
    const a = document.createElement('a')
    a.href = httpUrl
    a.download = 'tagtime_calendar.ics'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-900 rounded-2xl p-6 w-full max-w-lg shadow-xl border border-gray-200 dark:border-gray-800 space-y-5 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题 */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-2xl">🗓️</span>
            <h3 className="text-lg font-bold">日历同步与订阅 (iCalendar)</h3>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition"
          >
            ✕
          </button>
        </div>

        {/* 介绍 */}
        <div className="text-xs text-gray-500 dark:text-gray-400 bg-brand-50/50 dark:bg-brand-900/20 border border-brand-200/50 dark:border-brand-800/40 rounded-xl p-3 leading-relaxed">
          💡 将 TagTime 的计时活动同步到 <strong>iPhone、Mac、安卓手机日历、Google 日历、Outlook</strong> 等日历中。订阅后，日历软件会自动定时拉取并实时显示您的活动轨迹与打点记录。
        </div>

        {/* 过滤选项 */}
        <div className="space-y-3 bg-gray-50 dark:bg-gray-800/50 rounded-xl p-3.5 border border-gray-100 dark:border-gray-800 text-xs">
          <div className="font-semibold text-gray-700 dark:text-gray-300">⚙️ 订阅设置与过滤</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-gray-500 mb-1">同步时间范围</label>
              <div className="flex gap-1">
                {[
                  { value: '30', label: '近30天' },
                  { value: '90', label: '近90天 (默认)' },
                  { value: 'all', label: '全部历史' },
                ].map((item) => (
                  <button
                    key={item.value}
                    onClick={() => setDays(item.value as any)}
                    className={`flex-1 py-1 px-2 rounded-lg text-xs font-medium border transition ${
                      days === item.value
                        ? 'bg-brand text-white border-brand'
                        : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-brand'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-gray-500 mb-1">分类过滤</label>
              <select
                value={selectedCat}
                onChange={(e) => setSelectedCat(e.target.value)}
                className="w-full py-1.5 px-2.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-xs text-gray-700 dark:text-gray-200 focus:outline-none focus:border-brand"
              >
                <option value="">全部分类 (同步所有活动)</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.icon ? `${c.icon} ` : ''}{c.name}
                  </option>
                ))}
                <option value="none">未分类</option>
              </select>
            </div>
          </div>
        </div>

        {/* 订阅链接展示与复制 */}
        <div className="space-y-3">
          <div>
            <div className="flex items-center justify-between text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">
              <span>🌟 WebCal 订阅链接 (推荐)</span>
              {copiedType === 'webcal' && <span className="text-green-500 font-normal">✓ 已复制到剪贴板</span>}
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                readOnly
                value={webcalUrl}
                className="flex-1 text-xs font-mono bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2.5 py-1.5 text-gray-600 dark:text-gray-300 select-all"
              />
              <button
                onClick={() => copyToClipboard(webcalUrl, 'webcal')}
                className="px-3 py-1.5 rounded-lg bg-brand hover:bg-brand-600 text-white text-xs font-medium whitespace-nowrap transition"
              >
                复制链接
              </button>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">
              <span>🌐 HTTP/HTTPS 订阅链接</span>
              {copiedType === 'http' && <span className="text-green-500 font-normal">✓ 已复制到剪贴板</span>}
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                readOnly
                value={httpUrl}
                className="flex-1 text-xs font-mono bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2.5 py-1.5 text-gray-600 dark:text-gray-300 select-all"
              />
              <button
                onClick={() => copyToClipboard(httpUrl, 'http')}
                className="px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-200 text-xs font-medium whitespace-nowrap transition"
              >
                复制链接
              </button>
            </div>
          </div>

          <div className="pt-1 flex items-center justify-between">
            <span className="text-xs text-gray-400">单次导入无需订阅？</span>
            <button
              onClick={downloadIcs}
              className="text-xs text-brand hover:underline flex items-center gap-1 font-medium"
            >
              <span>📥 下载 .ics 日历文件</span>
            </button>
          </div>
        </div>

        {/* 快速配置指南 */}
        <div className="border-t border-gray-200 dark:border-gray-800 pt-4 space-y-3">
          <div className="text-xs font-semibold text-gray-700 dark:text-gray-300">📖 各平台订阅教程</div>
          
          <div className="flex gap-1 border-b border-gray-200 dark:border-gray-800 pb-2">
            {[
              { id: 'apple', label: '🍎 苹果 (iOS/Mac)' },
              { id: 'android', label: '🤖 安卓手机' },
              { id: 'google', label: '📅 谷歌日历' },
              { id: 'outlook', label: '💼 Outlook' },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`text-xs px-2.5 py-1 rounded-md transition ${
                  activeTab === tab.id
                    ? 'bg-brand-100 dark:bg-brand-900/40 text-brand font-medium'
                    : 'text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="text-xs text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/40 rounded-xl p-3 leading-relaxed">
            {activeTab === 'apple' && (
              <div className="space-y-1.5">
                <div className="font-medium text-gray-800 dark:text-gray-200">iPhone / iPad / Mac：</div>
                <div>1. 点击上方复制 <strong>WebCal 订阅链接</strong>。</div>
                <div>2. <strong>iPhone</strong>：打开系统「设置」→「日历」→「账户」→「添加账户」→「其他」→「添加已订阅的日历」，粘贴链接并保存。</div>
                <div>3. <strong>Mac</strong>：打开自带「日历」App → 顶部菜单栏「文件」→「新建日历订阅」→ 粘贴链接并确定。</div>
              </div>
            )}

            {activeTab === 'android' && (
              <div className="space-y-1.5">
                <div className="font-medium text-gray-800 dark:text-gray-200">华为 / 小米 / OPPO / vivo 等安卓手机：</div>
                <div>1. 复制上方的 <strong>WebCal 或 HTTP 订阅链接</strong>。</div>
                <div>2. 打开手机自带「日历」App → 点击右上角菜单或「设置」→ 找到「日程/日历管理」或「添加网络日历/订阅日历」。</div>
                <div>3. 粘贴订阅链接并设置刷新频率（如每小时同步）。</div>
              </div>
            )}

            {activeTab === 'google' && (
              <div className="space-y-1.5">
                <div className="font-medium text-gray-800 dark:text-gray-200">Google Calendar (谷歌日历)：</div>
                <div>1. 复制上方的 <strong>HTTP/HTTPS 订阅链接</strong>。</div>
                <div>2. 打开 Google Calendar 网页版 (calendar.google.com)。</div>
                <div>3. 在左侧「其他日历」右侧点击 <strong>+</strong> 号 → 选择「通过网址添加」。</div>
                <div>4. 粘贴链接并点击「添加日历」。</div>
              </div>
            )}

            {activeTab === 'outlook' && (
              <div className="space-y-1.5">
                <div className="font-medium text-gray-800 dark:text-gray-200">微软 Outlook / Windows 11 日历：</div>
                <div>1. 复制上方的 <strong>HTTP/HTTPS 或 WebCal 订阅链接</strong>。</div>
                <div>2. 打开 Outlook 网页版或客户端，切换到日历视图。</div>
                <div>3. 点击「添加日历」→「从 Web 订阅」→ 粘贴链接并命名保存。</div>
              </div>
            )}
          </div>
        </div>

        {/* 底部按钮 */}
        <div className="flex justify-end pt-2">
          <button
            onClick={onClose}
            className="px-5 py-2 rounded-xl bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200 text-xs font-medium transition"
          >
            完成
          </button>
        </div>
      </div>
    </div>
  )
}
