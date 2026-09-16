import { RangeSetBuilder, StateField } from '@codemirror/state'
import type { Text, EditorState, Extension, SelectionRange } from '@codemirror/state'
import { Decoration, DecorationSet, EditorView } from '@codemirror/view'
import { parseMarkdown, type Token } from './markdownTokens'
import { activeLineNumbers, tokensToRender } from './livePreview'
import { MathWidget, ImageWidget, SymbolWidget, HorizontalRuleWidget, TableWidget, TaskWidget, CodeBlockWidget, type CodeLineSourceRange } from './markdownWidgets'

// 单个待添加的装饰区间；先收集再按 (from, startSide) 全局排序，
// 避免重叠 token（例如 *斜体* 内部又嵌套 **粗体**）导致插入乱序而抛错。
interface DecoEntry {
  from: number
  to: number
  deco: Decoration
}

function fenceSourceLines(doc: Text, from: number, to: number): CodeLineSourceRange[] {
  const source = doc.sliceString(from, to)
  const lines = source.split('\n')
  if (lines.length < 2) return []
  const opening = lines[0]?.trim() ?? ''
  const marker = opening.match(/^(`{3,}|~{3,})/)?.[1]
  if (!marker) return []
  const closing = lines[lines.length - 1]?.trim() ?? ''
  const hasClosing = new RegExp(`^${marker[0]}{${marker.length},}[ \\t]*$`).test(closing)
  const start = 1
  const end = hasClosing ? lines.length - 1 : lines.length
  const ranges: CodeLineSourceRange[] = []
  let offset = from
  for (let index = 0; index < lines.length; index++) {
    if (index >= start && index < end) {
      ranges.push({ from: offset, to: offset + lines[index].length })
    }
    offset += lines[index].length + 1
  }
  return ranges
}

function apply(t: Token, doc: Text, out: DecoEntry[]): void {
  const lineAt = (pos: number) => doc.lineAt(Math.min(Math.max(pos, 0), doc.length))
  const add = (from: number, to: number, deco: Decoration) => out.push({ from, to, deco })

  switch (t.kind) {
    case 'heading': {
      const ln = lineAt(t.from)
      add(ln.from, ln.from, Decoration.line({ class: `cm-heading cm-heading-${t.level}` }))
      if (t.markerTo > t.markerFrom) add(t.markerFrom, t.markerTo, Decoration.replace({}))
      break
    }
    case 'blockquote': {
      const ln = lineAt(t.from)
      add(ln.from, ln.from, Decoration.line({ class: 'cm-blockquote' }))
      if (t.markerTo > t.markerFrom) add(t.markerFrom, t.markerTo, Decoration.replace({}))
      break
    }
    case 'list': {
      const ln = lineAt(t.from)
      add(ln.from, ln.from, Decoration.line({ class: `cm-list cm-list-${t.listType}` }))
      if (t.listType === 'bullet' && t.markerTo > t.markerFrom) {
        add(t.markerFrom, t.markerTo, Decoration.replace({ widget: new SymbolWidget('•', 'cm-list-marker', t.markerFrom, t.markerTo) }))
      } else if (t.listType === 'ordered' && t.markerTo > t.markerFrom) {
        add(t.markerFrom, t.markerTo, Decoration.replace({ widget: new SymbolWidget(t.markerText, 'cm-list-marker cm-list-marker-ordered', t.markerFrom, t.markerTo) }))
      } else if (t.listType === 'task' && t.markerTo > t.markerFrom) {
        add(t.markerFrom, t.markerTo, Decoration.replace({ widget: new TaskWidget(t.checked === true, t.checkedFrom ?? t.markerFrom, t.markerFrom, t.markerTo) }))
      }
      break
    }
    case 'table': {
      add(t.from, t.to, Decoration.replace({ widget: new TableWidget(t.rows, t.from, t.to), block: true }))
      break
    }
    case 'hr': {
      const ln = lineAt(t.from)
      add(ln.from, ln.from, Decoration.line({ class: 'cm-hr' }))
      if (t.to > t.from) add(t.from, t.to, Decoration.replace({ widget: new HorizontalRuleWidget(t.from, t.to) }))
      break
    }
    case 'fence': {
      add(t.from, t.to, Decoration.replace({ widget: new CodeBlockWidget(t.content, t.language, t.from, t.to, fenceSourceLines(doc, t.from, t.to)), block: true }))
      break
    }
    case 'strong': {
      add(t.from, t.contentFrom, Decoration.replace({}))
      add(t.contentFrom, t.contentTo, Decoration.mark({ class: 'cm-strong' }))
      add(t.contentTo, t.to, Decoration.replace({}))
      break
    }
    case 'em': {
      add(t.from, t.contentFrom, Decoration.replace({}))
      add(t.contentFrom, t.contentTo, Decoration.mark({ class: 'cm-em' }))
      add(t.contentTo, t.to, Decoration.replace({}))
      break
    }
    case 'strike': {
      add(t.from, t.contentFrom, Decoration.replace({}))
      add(t.contentFrom, t.contentTo, Decoration.mark({ class: 'cm-strike' }))
      add(t.contentTo, t.to, Decoration.replace({}))
      break
    }
    case 'inlineCode': {
      add(t.from, t.contentFrom, Decoration.replace({}))
      add(t.contentFrom, t.contentTo, Decoration.mark({ class: 'cm-inline-code' }))
      add(t.contentTo, t.to, Decoration.replace({}))
      break
    }
    case 'link': {
      add(t.from, t.textFrom, Decoration.replace({}))
      add(t.textFrom, t.textTo, Decoration.mark({ class: 'cm-link' }))
      add(t.textTo, t.to, Decoration.replace({}))
      break
    }
    case 'wikilink': {
      add(t.from, t.contentFrom, Decoration.replace({}))
      add(t.contentFrom, t.contentTo, Decoration.mark({ class: 'cm-wikilink' }))
      add(t.contentTo, t.to, Decoration.replace({}))
      break
    }
    case 'image': {
      add(t.from, t.to, Decoration.replace({ widget: new ImageWidget(t.alt, t.url, t.from, t.to) }))
      break
    }
    case 'math': {
      if (t.display) {
        add(t.from, t.to, Decoration.replace({ widget: new MathWidget(t.expression, true, t.from, t.to), block: true }))
      } else {
        add(t.from, t.to, Decoration.replace({ widget: new MathWidget(t.expression, false, t.from, t.to) }))
      }
      break
    }
  }
}

function buildDecorations(doc: Text, ranges: readonly SelectionRange[], tokens: Token[]): DecorationSet {
  const active = activeLineNumbers(doc, ranges)
  const entries: DecoEntry[] = []
  for (const t of tokensToRender(doc, tokens, active)) {
    apply(t, doc, entries)
  }
  entries.sort((a, b) => a.from - b.from || a.deco.startSide - b.deco.startSide)
  const b = new RangeSetBuilder<Decoration>()
  for (const e of entries) b.add(e.from, e.to, e.deco)
  return b.finish()
}

function lineSourcePositionAtPoint(event: MouseEvent, view: EditorView): number | null {
  const target = event.target instanceof Element ? event.target : null
  const lineElement = target?.closest<HTMLElement>('.cm-line')
  if (!lineElement || !view.contentDOM.contains(lineElement)) return null
  if (target?.closest('.cm-task-marker')) return null

  const rect = lineElement.getBoundingClientRect()
  const block = view.lineBlockAtHeight(event.clientY - view.documentTop)
  const line = view.state.doc.lineAt(block.from)
  try {
    // posAtCoords 会把被 Decoration.replace 隐藏的 Markdown 标记当成零宽，
    // 因此只取它相对当前 DOM 行起点的偏移，再加回真实源码行起点。
    const domLineStart = view.posAtDOM(lineElement, 0)
    const domPoint = view.posAtCoords({ x: event.clientX, y: event.clientY }, false)
    const delta = domPoint - domLineStart
    return Math.min(line.to, Math.max(line.from, line.from + delta))
  } catch {
    const ratio = rect.width > 0 ? Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) : 0
    return line.from + Math.round(line.length * ratio)
  }
}

// 块级装饰（如 $$ 展示公式的 block widget、列表/标题/引用 / 代码块等）必须经由
// StateField 提供，ViewPlugin 的 decorations 只允许行内装饰，否则会抛
// “Block decorations may not be specified via plugins”。这里用 StateField 承载整套
// Live Preview 装饰，并在 doc 变更或选区变化时重建（复用按 doc 解析的 token 缓存）。
interface LivePreviewState {
  decorations: DecorationSet
  tokens: Token[]
  doc: Text
}

function compute(state: EditorState, prev?: LivePreviewState): LivePreviewState {
  const doc = state.doc
  const tokens = prev && prev.doc.eq(doc) ? prev.tokens : parseMarkdown(doc.toString())
  return {
    decorations: buildDecorations(doc, state.selection.ranges, tokens),
    tokens,
    doc,
  }
}

export const livePreviewField = StateField.define<LivePreviewState>({
  create(state) {
    return compute(state)
  },
  update(value, tr) {
    if (tr.docChanged || tr.selection) return compute(tr.state, value)
    return value
  },
  provide: (f) => EditorView.decorations.from(f, (value) => value.decorations),
})

export const livePreviewPlugin: Extension = [
  livePreviewField,
  EditorView.domEventHandlers({
    mousedown(event, view) {
      if (event.button !== 0) return false
      const position = lineSourcePositionAtPoint(event, view)
      if (position === null) return false
      event.preventDefault()
      view.dispatch({ selection: { anchor: position }, scrollIntoView: true })
      view.focus()
      return true
    },
  }),
]
