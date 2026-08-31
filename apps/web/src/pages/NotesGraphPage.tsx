import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import * as d3 from 'd3-force'
import { api } from '../api'
import type { GraphData, GraphNode } from '../types'

interface SimNode extends d3.SimulationNodeDatum {
  id: string
  title: string
  path: string | null
  isCurrent?: boolean
  isUnresolved?: boolean
  level?: number
  fx?: number
  fy?: number
}

interface SimLink extends d3.SimulationLinkDatum<SimNode> {
  resolved: boolean
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const svgEl = (tag: string): SVGElement => document.createElementNS(SVG_NS, tag)

export default function NotesGraphPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const svgRef = useRef<SVGSVGElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [data, setData] = useState<GraphData | null>(null)
  const [error, setError] = useState('')
  const [depth, setDepth] = useState(1)
  const [limit, setLimit] = useState(50)
  const [loading, setLoading] = useState(false)
  const [hover, setHover] = useState<GraphNode | null>(null)
  const viewGroupRef = useRef<SVGGElement>(null)
  const [view, setView] = useState({ x: 0, y: 0, k: 1 })

  const isLocal = Boolean(id)

  const zoomTo = (s: number, px?: number, py?: number) => {
    setView((v) => {
      const nextK = Math.min(3, Math.max(0.3, v.k + s))
      const kRatio = nextK / (v.k || 1)
      const x = px != null ? px - (px - v.x) * kRatio : v.x
      const y = py != null ? py - (py - v.y) * kRatio : v.y
      return { x, y, k: nextK }
    })
  }
  const resetView = () => setView({ x: 0, y: 0, k: 1 })

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const d = id
        ? await api.notes.localGraph(id, depth)
        : await api.notes.globalGraph({ limit })
      setData(d)
    } catch (e: any) {
      setError(`加载关系图失败：${e.message}`)
      setData(null)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [id, depth, limit])

  const nodes = useMemo<SimNode[]>(() => {
    if (!data) return []
    return data.nodes.map((n) => ({
      id: n.id,
      title: n.title,
      path: n.path,
      isCurrent: n.isCurrent,
      isUnresolved: n.isUnresolved,
      level: n.level,
    }))
  }, [data])

  const links = useMemo<SimLink[]>(() => {
    if (!data) return []
    return data.links.map((l) => ({
      source: l.source as string,
      target: l.target as string,
      resolved: l.resolved,
    }))
  }, [data])

  useEffect(() => {
    const svg = svgRef.current
    const wrap = wrapRef.current
    if (!svg || !wrap || nodes.length === 0) return

    // 清空并重建图层
    const linksLayer = svg.querySelector('g[data-layer="links"]') as SVGGElement | null
    const nodesLayer = svg.querySelector('g[data-layer="nodes"]') as SVGGElement | null
    const labelsLayer = svg.querySelector('g[data-layer="labels"]') as SVGGElement | null
    if (!linksLayer || !nodesLayer || !labelsLayer) return
    linksLayer.textContent = ''
    nodesLayer.textContent = ''
    labelsLayer.textContent = ''

    const width = wrap.clientWidth
    const height = Math.max(420, wrap.clientHeight || 560)
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`)

    const center = nodes.find((n) => n.isCurrent)

    let sim: d3.Simulation<SimNode, SimLink>
    if (center) {
      sim = d3.forceSimulation<SimNode>(nodes)
        .force('link', d3.forceLink<SimNode, SimLink>(links).id((d) => d.id).distance(90))
        .force('charge', d3.forceManyBody().strength(-260))
        .force('collide', d3.forceCollide<SimNode>().radius((d) => 26 + (d.isCurrent ? 16 : 0)))
        .force('center', d3.forceCenter(width / 2, height / 2))
      center.fx = width / 2
      center.fy = height / 2
    } else {
      sim = d3.forceSimulation<SimNode>(nodes)
        .force('link', d3.forceLink<SimNode, SimLink>(links).id((d) => d.id).distance(80).strength(0.4))
        .force('charge', d3.forceManyBody().strength(-380))
        .force('center', d3.forceCenter(width / 2, height / 2))
        .force('x', d3.forceX(width / 2).strength(0.05))
        .force('y', d3.forceY(height / 2).strength(0.05))
    }

    // 建立 line 元素
    const lines = links.map((l) => {
      const line = svgEl('line')
      line.setAttribute('stroke', l.resolved ? '#94a3b8' : '#f59e0b')
      line.setAttribute('stroke-opacity', l.resolved ? '0.5' : '0.6')
      line.setAttribute('stroke-width', l.resolved ? '1.2' : '1.6')
      if (!l.resolved) line.setAttribute('stroke-dasharray', '4 3')
      linksLayer.appendChild(line)
      return line
    })

    // 建立 node 元素
    const nodeGs = nodes.map((n) => {
      const g = svgEl('g')
      g.style.cursor = n.isUnresolved ? 'default' : 'pointer'

      const circle = svgEl('circle')
      circle.setAttribute('r', String(n.isCurrent ? 18 : n.isUnresolved ? 9 : 12))
      circle.setAttribute('fill', n.isUnresolved ? '#f59e0b' : n.isCurrent ? '#6366f1' : '#818cf8')
      circle.setAttribute('stroke', '#fff')
      circle.setAttribute('stroke-width', n.isCurrent ? '2.5' : '1.5')
      if (n.isUnresolved) circle.setAttribute('fill-opacity', '0.7')
      g.appendChild(circle)

      // 点击跳转
      if (!n.isUnresolved) {
        g.addEventListener('click', () => navigate(`/notes/${n.id}`))
      }
      g.addEventListener('mouseenter', () => setHover(n))
      g.addEventListener('mouseleave', () => setHover(null))

      // 拖拽
      g.addEventListener('mousedown', (ev) => {
        ev.preventDefault()
        sim.alphaTarget(0.3).restart()
        n.fx = n.x ?? 0
        n.fy = n.y ?? 0
        const onMove = (me: MouseEvent) => {
          const rect = svg.getBoundingClientRect()
          n.fx = me.clientX - rect.left
          n.fy = me.clientY - rect.top
        }
        const onUp = () => {
          sim.alphaTarget(0)
          n.fx = null as unknown as number
          n.fy = null as unknown as number
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup', onUp)
        }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
      })

      nodesLayer.appendChild(g)
      return { g, data: n }
    })

    // 建立 label 元素
    const labelEls = nodes.map((n) => {
      const t = svgEl('text')
      t.setAttribute('class', 'node-label')
      t.setAttribute('text-anchor', 'middle')
      t.setAttribute('dy', n.isCurrent ? '-26' : '-16')
      t.setAttribute('font-size', n.isCurrent ? '13' : '11')
      t.setAttribute('font-weight', n.isCurrent ? '700' : '400')
      t.setAttribute('fill', '#64748b')
      t.style.pointerEvents = 'none'
      t.textContent = n.title
      labelsLayer.appendChild(t)
      return t
    })

    sim.on('tick', () => {
      for (let i = 0; i < lines.length; i++) {
        const l = links[i]
        const src = l.source as SimNode
        const tgt = l.target as SimNode
        lines[i].setAttribute('x1', String(src.x ?? 0))
        lines[i].setAttribute('y1', String(src.y ?? 0))
        lines[i].setAttribute('x2', String(tgt.x ?? 0))
        lines[i].setAttribute('y2', String(tgt.y ?? 0))
      }
      for (let i = 0; i < nodeGs.length; i++) {
        const d = nodeGs[i].data
        nodeGs[i].g.setAttribute('transform', `translate(${d.x ?? 0},${d.y ?? 0})`)
        labelEls[i].setAttribute('transform', `translate(${d.x ?? 0},${d.y ?? 0})`)
      }
    })

    return () => {
      sim.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, nodes, links])

  const currentTitle = useMemo(() => {
    if (!isLocal || !nodes.length) return ''
    return nodes.find((n) => n.isCurrent)?.title ?? ''
  }, [isLocal, nodes])

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate('/notes')}
            className="px-3 py-1.5 text-sm rounded-xl border border-gray-200 dark:border-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          >
            ← 返回
          </button>
          <h1 className="text-lg font-bold text-gray-800 dark:text-gray-100">
            {isLocal ? <>关联图 · {currentTitle}</> : '全部笔记关系图'}
          </h1>
        </div>
        <div className="flex items-center gap-2 text-sm">
          {isLocal && (
            <>
              <label className="text-xs text-gray-500 dark:text-gray-400">深度</label>
              <select
                value={depth}
                onChange={(e) => setDepth(Number(e.target.value))}
                className="px-2 py-1.5 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 text-sm"
              >
                <option value={1}>1 层</option>
                <option value={2}>2 层</option>
              </select>
            </>
          )}
          {!isLocal && (
            <>
              <label className="text-xs text-gray-500 dark:text-gray-400">节点上限</label>
              <select
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value))}
                className="px-2 py-1.5 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 text-sm"
              >
                <option value={30}>30</option>
                <option value={50}>50</option>
                <option value={100}>100</option>
              </select>
            </>
          )}
          <button
            onClick={load}
            disabled={loading}
            className="px-3 py-1.5 text-sm bg-brand text-white rounded-xl hover:bg-brand-600 disabled:opacity-50 transition-colors"
          >
            刷新
          </button>
        </div>
      </div>

      {/* 图例 */}
      <div className="flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400">
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-[#818cf8]" /> 已解析笔记</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-[#f59e0b]" /> 未解析链接</span>
        <span className="flex items-center gap-1.5"><span className="w-6 h-0.5 bg-gray-400" /> 已解析边</span>
        <span className="flex items-center gap-1.5"><span className="w-4 h-0 border-t-2 border-dashed border-amber-500" /> 未解析边</span>
      </div>

      {error && (
        <div className="text-sm text-red-500 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl px-4 py-3">
          {error}
        </div>
      )}

      {loading && !data && (
        <div className="text-center py-20 text-sm text-gray-400">加载关系图…</div>
      )}

      {!loading && data && nodes.length === 0 && (
        <div className="text-center py-16 text-sm text-gray-400">
          {isLocal ? '这篇笔记还没有任何关联。' : '暂无笔记节点。'}
        </div>
      )}

      <div
        ref={wrapRef}
        className="relative rounded-2xl border border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden"
        style={{ height: '68vh', minHeight: 440 }}
      >
        <svg
          ref={svgRef}
          className="w-full h-full select-none"
          onWheel={(ev) => {
            ev.preventDefault()
            const rect = ev.currentTarget.getBoundingClientRect()
            zoomTo(-ev.deltaY * 0.0015, ev.clientX - rect.left, ev.clientY - rect.top)
          }}
        >
          <g ref={viewGroupRef} transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
            <g data-layer="links" />
            <g data-layer="nodes" />
            <g data-layer="labels" />
          </g>
        </svg>

        {/* 缩放控制 */}
        <div className="absolute top-3 right-3 flex flex-col gap-1">
          <button
            onClick={() => zoomTo(0.3)}
            className="w-8 h-8 rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 text-sm font-bold hover:bg-gray-50 dark:hover:bg-gray-700 shadow-sm"
            title="放大"
          >
            ＋
          </button>
          <button
            onClick={() => zoomTo(-0.3)}
            className="w-8 h-8 rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 text-sm font-bold hover:bg-gray-50 dark:hover:bg-gray-700 shadow-sm"
            title="缩小"
          >
            −
          </button>
          <button
            onClick={resetView}
            className="w-8 h-8 rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 text-sm font-bold hover:bg-gray-50 dark:hover:bg-gray-700 shadow-sm"
            title="回到中心 / 当前笔记"
          >
            ⌖
          </button>
        </div>

        {data?.truncated && (
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 text-[11px] px-3 py-1 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-500">
            节点过多已截断
          </div>
        )}

        {hover && (
          <div className="absolute top-3 left-3 text-xs text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/80 backdrop-blur px-3 py-2 rounded-xl max-w-[260px]">
            <div className="font-semibold text-gray-800 dark:text-gray-100 truncate">
              {hover.isUnresolved ? '🔗 ' : ''}{hover.title}
            </div>
            {hover.isUnresolved ? (
              <div className="text-amber-600 dark:text-amber-400 mt-0.5">存在指向这篇未创建笔记的链接</div>
            ) : (
              <div className="text-gray-400 truncate">{hover.path}</div>
            )}
          </div>
        )}
      </div>

      <div className="text-xs text-gray-400 dark:text-gray-500">
        提示：拖拽节点可调整布局，点击已解析节点跳转到该笔记，悬停查看详情。{isLocal ? '蓝色为中心笔记。' : ''}
      </div>
    </div>
  )
}