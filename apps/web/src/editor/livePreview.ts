// Live Preview 核心判定逻辑（纯函数，无 DOM/CSS/KaTeX 依赖），便于单元测试。
import type { Text, SelectionRange } from '@codemirror/state'
import type { Token } from './markdownTokens'

// 收集选区覆盖到的行号集合：这些行显示源码，其余行做 Live Preview 渲染。
export function activeLineNumbers(doc: Text, ranges: readonly SelectionRange[]): Set<number> {
  const set = new Set<number>()
  for (const r of ranges) {
    const fl = doc.lineAt(r.from).number
    const tl = doc.lineAt(r.to).number
    for (let l = fl; l <= tl; l++) set.add(l)
  }
  return set
}

// token 是否与任一活动（光标/选区）行相交：是则保留为源码，否则渲染。
export function intersects(token: Token, doc: Text, active: Set<number>): boolean {
  const fl = doc.lineAt(Math.max(0, token.from)).number
  const tl = doc.lineAt(Math.min(token.to, doc.length)).number
  for (let l = fl; l <= tl; l++) if (active.has(l)) return true
  return false
}

// 给定文档、解析结果与活动行，返回需要“渲染（隐藏标记）”的 token 列表。
export function tokensToRender(doc: Text, tokens: Token[], active: Set<number>): Token[] {
  return tokens
    .filter((t) => !intersects(t, doc, active))
    .sort((a, b) => a.from - b.from)
}