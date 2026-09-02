import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useStore, formatDuration } from '../store'
import type { Summary, DailyStat, TagStat, Goal } from '../types'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell,
} from 'recharts'

const MS_TO_HOUR = (ms: number) => Number((ms / 3600000).toFixed(2))

export default function StatsPage() {
  const { categories } = useStore()
  const [summary, setSummary] = useState<Summary | null>(null)
  const [daily, setDaily] = useState<DailyStat[]>([])
  const [byTag, setByTag] = useState<TagStat[]>([])
  const [goals, setGoals] = useState<Goal[]>([])
  // 时间范围：预设天数 或 'custom' 自定义区间
  const [range, setRange] = useState<7 | 14 | 30 | 'custom'>(7)
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [filterCat, setFilterCat] = useState('')
  const summaryRequest = useRef(0)
  const trendRequest = useRef(0)
  const [summaryError, setSummaryError] = useState('')
  const [trendError, setTrendError] = useState('')

  // 加载目标进度
  useEffect(() => {
    api.goals.list().then(setGoals).catch(() => setGoals([]))
  }, [])

  useEffect(() => {
    const sequence = ++summaryRequest.current
    setSummaryError('')
    api.stats.summary(filterCat || undefined)
      .then((result) => {
        if (sequence === summaryRequest.current) setSummary(result)
      })
      .catch((err) => {
        if (sequence === summaryRequest.current) {
          setSummaryError(err instanceof Error ? err.message : '概览加载失败')
        }
      })
  }, [filterCat])

  useEffect(() => {
    const sequence = ++trendRequest.current
    setTrendError('')
    if (range === 'custom') {
      // 自定义区间：需要同时有起止日期才查询
      if (!customFrom || !customTo) {
        setDaily([])
        setByTag([])
        return
      }
      const fromIso = new Date(customFrom + 'T00:00:00').toISOString()
      const toIso = new Date(customTo + 'T23:59:59').toISOString()
      Promise.all([
        api.stats.daily({ from: fromIso, to: toIso, categoryId: filterCat || undefined }),
        api.stats.byTag(fromIso, toIso, filterCat || undefined),
      ])
        .then(([nextDaily, nextByTag]) => {
          if (sequence !== trendRequest.current) return
          setDaily(nextDaily)
          setByTag(nextByTag)
        })
        .catch((err) => {
          if (sequence === trendRequest.current) {
            setTrendError(err instanceof Error ? err.message : '趋势数据加载失败')
          }
        })
    } else {
      // 预设天数
      const now = new Date()
      const from = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      from.setDate(from.getDate() - (range - 1))
      Promise.all([
        api.stats.daily({ days: range, categoryId: filterCat || undefined }),
        api.stats.byTag(from.toISOString(), now.toISOString(), filterCat || undefined),
      ])
        .then(([nextDaily, nextByTag]) => {
          if (sequence !== trendRequest.current) return
          setDaily(nextDaily)
          setByTag(nextByTag)
        })
        .catch((err) => {
          if (sequence === trendRequest.current) {
            setTrendError(err instanceof Error ? err.message : '趋势数据加载失败')
          }
        })
    }
  }, [range, filterCat, customFrom, customTo])

  // 每日趋势数据
  const trendData = daily.map((d) => ({
    date: d.date.slice(5),
    hours: MS_TO_HOUR(d.total),
  }))

  // 按分类占比（饼图）——仅在未筛选分类时显示
  const pieData = summary?.todayByCategory.map((c) => ({
    name: c.name,
    value: MS_TO_HOUR(c.ms),
    color: c.color,
  })) ?? []

  const filterLabel = filterCat === 'none' ? '未分类' : categories.find((c) => c.id === filterCat)?.name

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-xl font-bold">统计</h1>
        {/* 分类筛选 */}
        <select
          value={filterCat}
          onChange={(e) => setFilterCat(e.target.value)}
          className="text-sm border border-gray-200 dark:border-gray-800 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300"
        >
          <option value="">全部分类</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
          <option value="none">未分类</option>
        </select>
      </div>

      {(summaryError || trendError) && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300">
          {summaryError || trendError}
        </div>
      )}

      {/* 概览卡片 */}
      <div className="grid grid-cols-3 gap-3">
        <MetricCard label="今日" value={summary ? formatDuration(summary.today) : '…'} />
        <MetricCard label="本周" value={summary ? formatDuration(summary.week) : '…'} />
        <MetricCard label="本月" value={summary ? formatDuration(summary.month) : '…'} />
      </div>

      {/* 目标进度 */}
      {goals.length > 0 && (
        <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 p-4">
          <h2 className="text-sm font-semibold text-gray-500 mb-3">目标进度</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {goals.map((goal) => {
              const current = goal.current ?? 0
              const target = goal.target
              const done = target > 0 && current >= target
              const percent = target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0
              return (
                <div key={goal.id} className="flex items-center gap-3 rounded-lg border border-gray-100 dark:border-gray-800 p-3">
                  {/* 进度环 */}
                  <div className="relative w-12 h-12 flex-shrink-0">
                    <svg className="w-12 h-12 -rotate-90" viewBox="0 0 48 48">
                      <circle cx="24" cy="24" r="20" fill="none" stroke="currentColor" strokeWidth="4" className="text-gray-100 dark:text-gray-800" />
                      <circle
                        cx="24" cy="24" r="20" fill="none" stroke={goal.tag?.color ?? '#6d5efc'} strokeWidth="4"
                        strokeDasharray={`${(percent / 100) * 125.6} 125.6`}
                        strokeLinecap="round"
                      />
                    </svg>
                    <div className="absolute inset-0 flex items-center justify-center text-xs font-bold" style={{ color: goal.tag?.color ?? '#6d5efc' }}>
                      {done ? '✓' : `${percent}%`}
                    </div>
                  </div>
                  {/* 信息 */}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{goal.title}</div>
                    <div className="text-xs text-gray-400">
                      {current}{goal.type === 'count' ? '次' : '分'} / {target}{goal.type === 'count' ? '次' : '分'}
                    </div>
                    <div className="text-xs" style={{ color: done ? '#10b981' : '#9ca3af' }}>
                      {goal.period === 'daily' ? '今日' : goal.period === 'weekly' ? '本周' : goal.period === 'monthly' ? '本月' : `近${goal.periodDays}天`}
                      {done && ' · 已达成'}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* 时间范围选择 */}
      <div className="flex items-center gap-2 flex-wrap">
        {([7, 14, 30] as const).map((r) => (
          <button
            key={r}
            onClick={() => setRange(r)}
            className={`px-3 py-1 rounded-full text-sm ${range === r ? 'bg-brand-100 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300' : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'}`}
          >
            {r} 天
          </button>
        ))}
        <button
          onClick={() => setRange('custom')}
          className={`px-3 py-1 rounded-full text-sm ${range === 'custom' ? 'bg-brand-100 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300' : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'}`}
        >
          自定义
        </button>
        {range === 'custom' && (
          <div className="flex items-center gap-2 ml-1">
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              max={customTo || undefined}
              className="text-sm border border-gray-200 dark:border-gray-800 rounded-lg px-2 py-1 bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300"
            />
            <span className="text-gray-400 text-sm">至</span>
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              min={customFrom || undefined}
              className="text-sm border border-gray-200 dark:border-gray-800 rounded-lg px-2 py-1 bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300"
            />
          </div>
        )}
      </div>

      {/* 每日趋势柱状图 */}
      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 p-4">
        <h2 className="text-sm font-semibold text-gray-500 mb-3">
          每日时长趋势（小时）{range === 'custom' && customFrom && customTo ? `· ${customFrom} ~ ${customTo}` : filterLabel && <span className="text-gray-400 ml-1">· {filterLabel}</span>}
        </h2>
        {trendData.length === 0 ? (
          <Empty />
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={trendData}>
              <CartesianGrid strokeDasharray="3 3" className="opacity-20" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip
                formatter={(v: number) => [`${v}h`, '时长']}
                contentStyle={{ fontSize: 12, borderRadius: 8 }}
              />
              <Bar dataKey="hours" fill="#6d5efc" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* 今日分类占比 —— 仅在未筛选分类时显示 */}
      {!filterCat && (
        <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 p-4">
          <h2 className="text-sm font-semibold text-gray-500 mb-3">今日分类占比</h2>
          {pieData.length === 0 ? (
            <Empty />
          ) : (
            <div className="flex flex-col md:flex-row items-center gap-4">
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80}
                    label={(e) => `${e.name}`}>
                    {pieData.map((d, i) => (
                      <Cell key={i} fill={d.color} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v: number) => [`${v}h`, '时长']} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      )}

      {/* 标签排行 */}
      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 p-4">
        <h2 className="text-sm font-semibold text-gray-500 mb-3">
          标签时长排行（{range === 'custom' ? `${customFrom || '?'} ~ ${customTo || '?'}` : `近 ${range} 天`}{filterLabel && <span className="text-gray-400 ml-1">· {filterLabel}</span>}）
        </h2>
        {byTag.length === 0 ? (
          <Empty />
        ) : (
          <div className="space-y-2">
            {byTag.slice(0, 12).map((t) => {
              const max = byTag[0].ms || 1
              return (
                <div key={t.tagId} className="flex items-center gap-3">
                  <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: t.color }} />
                  <span className="text-sm w-20 truncate">{t.tagName}</span>
                  <div className="flex-1 h-5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${(t.ms / max) * 100}%`, background: t.color }}
                    />
                  </div>
                  <span className="text-xs text-gray-400 font-mono w-20 text-right">
                    {formatDuration(t.ms)}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 p-4 text-center">
      <div className="text-xs text-gray-400 mb-1">{label}</div>
      <div className="text-lg font-bold text-brand">{value}</div>
    </div>
  )
}

function Empty() {
  return <div className="text-center py-8 text-gray-400 text-sm">暂无数据</div>
}
