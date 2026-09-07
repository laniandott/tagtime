import { EditorView, WidgetType } from '@codemirror/view'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { normalizeMathExpression } from './markdownTokens'
import { createUniquePlaceholder } from './placeholders'
import type { TableRow } from './markdownTokens'

const TABLE_MATH_RE = /\\\([^\n]*?\\\)|\$[^$\n]+?\$/g

function safeImageUrl(value: string): string | null {
  const url = value.trim()
  if (!url || url.startsWith('//')) return null
  if (/^data:image\/(?:png|jpe?g|gif|webp|bmp|avif);/i.test(url)) return url
  if (/^[a-z][a-z\d+.-]*:/i.test(url)) {
    try {
      const parsed = new URL(url)
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null
    } catch {
      return null
    }
  }
  // 相对路径及同源绝对路径可用于笔记附件；禁止协议相对地址。
  return url.startsWith('/') || url.startsWith('./') || url.startsWith('../') || !url.includes(':') ? url : null
}

function renderTableCell(cell: string, element: HTMLElement): void {
  const codeTokens: Array<{ token: string; text: string }> = []
  const mathTokens: Array<{ token: string; expression: string }> = []
  const usedPlaceholders = new Set<string>()
  let source = cell.replace(/`[^`\n]+`/g, (full) => {
    const token = createUniquePlaceholder('TAGTIMETABLECODE', cell, usedPlaceholders)
    codeTokens.push({ token, text: full.slice(1, -1) })
    return `\`${token}\``
  })
  source = source.replace(TABLE_MATH_RE, (full) => {
    const expression = full.startsWith('\\(') ? full.slice(2, -2) : full.slice(1, -1)
    const token = createUniquePlaceholder('TAGTIMETABLEMATH', source, usedPlaceholders)
    mathTokens.push({ token, expression })
    return token
  })
  let html = marked.parseInline(source, { async: false }) as string
  for (const { token, expression } of mathTokens) {
    html = html.replaceAll(token, katex.renderToString(normalizeMathExpression(expression), {
      throwOnError: false,
      strict: 'ignore',
      trust: false,
    }))
  }
  element.innerHTML = DOMPurify.sanitize(html)
  for (const { token, text } of codeTokens) {
    for (const code of element.querySelectorAll('code')) {
      if (code.textContent === token) code.textContent = text
    }
  }
}

function sourcePositionAtPoint(
  view: EditorView,
  el: HTMLElement,
  event: MouseEvent,
  sourceFrom: number,
  sourceTo: number,
): number {
  const from = Math.min(Math.max(sourceFrom, 0), view.state.doc.length)
  const to = Math.min(Math.max(sourceTo, from), view.state.doc.length)
  if (to <= from) return from

  if (el.classList.contains('cm-table')) {
    return tableSourcePositionAtPoint(view, el, event, from, to)
  }
  if (el.classList.contains('cm-code-block-widget')) {
    return codeBlockSourcePositionAtPoint(view, el, event, from, to)
  }

  const rect = el.getBoundingClientRect()
  const xRatio = rect.width > 0 ? Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) : 0
  const yRatio = rect.height > 0 ? Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)) : 0
  const source = view.state.doc.sliceString(from, to)
  const isBlock = el.classList.contains('cm-math-display')
    || el.classList.contains('cm-table')
    || el.classList.contains('cm-code-block-widget')

  if (!isBlock || !source.includes('\n')) {
    return from + Math.round(source.length * xRatio)
  }

  const lines = source.split('\n')
  const lineIndex = Math.min(lines.length - 1, Math.round((lines.length - 1) * yRatio))
  const lineStart = lines.slice(0, lineIndex).reduce((offset, line) => offset + line.length + 1, 0)
  return from + lineStart + Math.round(lines[lineIndex].length * xRatio)
}

interface TableCellSpan {
  start: number
  end: number
}

export interface CodeLineSourceRange {
  from: number
  to: number
}

function tableCellSpans(line: string): TableCellSpan[] {
  const spans: TableCellSpan[] = []
  const contentStart = line.startsWith('|') ? 1 : 0
  const contentEnd = line.endsWith('|') && !line.endsWith('\\|') ? line.length - 1 : line.length
  let start = contentStart
  let escaped = false
  for (let index = contentStart; index <= contentEnd; index++) {
    const char = line[index]
    if (char === '\\' && !escaped) {
      escaped = true
      continue
    }
    const isEnd = index === contentEnd
    if ((char === '|' && !escaped) || isEnd) {
      let end = index
      while (start < end && /\s/.test(line[start] ?? '')) start++
      while (end > start && /\s/.test(line[end - 1] ?? '')) end--
      spans.push({ start, end })
      start = index + 1
    }
    escaped = false
  }
  return spans
}

function tableSourcePositionAtPoint(
  view: EditorView,
  el: HTMLElement,
  event: MouseEvent,
  from: number,
  to: number,
): number {
  const source = view.state.doc.sliceString(from, to)
  const lines = source.split('\n')
  const rows = Array.from(el.querySelectorAll('tr'))
  if (!rows.length || !lines.length) return from

  // 只按实际渲染出来的行命中，避免表格上下 padding/行高差异把第一行映射到第三行。
  const rowIndex = rows.reduce((best, row, index) => {
    const rect = row.getBoundingClientRect()
    const center = rect.top + rect.height / 2
    const bestRect = rows[best]?.getBoundingClientRect()
    const bestDistance = bestRect ? Math.abs(event.clientY - (bestRect.top + bestRect.height / 2)) : Number.POSITIVE_INFINITY
    const distance = Math.abs(event.clientY - center)
    return distance < bestDistance ? index : best
  }, 0)
  // Markdown 表格的第二行是分隔线，渲染层不会生成对应 tr。
  const sourceLineIndex = Math.min(lines.length - 1, rowIndex === 0 ? 0 : rowIndex + 1)
  const line = lines[sourceLineIndex] ?? ''
  const lineStart = lines.slice(0, sourceLineIndex).reduce((offset, value) => offset + value.length + 1, 0)
  const cells = Array.from(rows[rowIndex]?.querySelectorAll(':scope > th, :scope > td') ?? [])
  if (!cells.length) return from + lineStart

  const cellIndex = cells.reduce((best, cell, index) => {
    const rect = cell.getBoundingClientRect()
    const center = rect.left + rect.width / 2
    const bestRect = cells[best]?.getBoundingClientRect()
    const bestDistance = bestRect ? Math.abs(event.clientX - (bestRect.left + bestRect.width / 2)) : Number.POSITIVE_INFINITY
    const distance = Math.abs(event.clientX - center)
    return distance < bestDistance ? index : best
  }, 0)
  const spans = tableCellSpans(line)
  const span = spans[cellIndex]
  if (!span) return from + lineStart
  const rect = cells[cellIndex].getBoundingClientRect()
  const ratio = rect.width > 0 ? Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) : 0
  return from + lineStart + span.start + Math.round((span.end - span.start) * ratio)
}

function codeBlockSourcePositionAtPoint(
  view: EditorView,
  el: HTMLElement,
  event: MouseEvent,
  from: number,
  to: number,
): number {
  const source = view.state.doc.sliceString(from, to)
  const sourceLines = source.split('\n')
  const visibleLineElements = Array.from(el.querySelectorAll<HTMLElement>('.cm-code-line'))
  const visibleLines = visibleLineElements.length > 0
    ? visibleLineElements.map((line) => line.textContent?.replace(/\u200b$/, '') ?? '')
    : (el.querySelector('code')?.textContent ?? '').split('\n')
  if (!sourceLines.length || !visibleLines.length) return from

  // 代码 widget 只显示围栏内部，源码范围还包含开头/结尾的 ```；
  // 先找到真实内容行的起点，再按实际行高定位，避免预览与源码坐标错一行甚至多行。
  let bodyStart = 0
  if (/^\s{0,3}(?:`{3,}|~{3,})/.test(sourceLines[0] ?? '')) bodyStart = 1
  const maxBodyStart = Math.max(0, sourceLines.length - visibleLines.length)
  for (let index = bodyStart; index <= maxBodyStart; index++) {
    if (sourceLines.slice(index, index + visibleLines.length).join('\n') === visibleLines.join('\n')) {
      bodyStart = index
      break
    }
  }

  const target = event.target instanceof Element ? event.target.closest<HTMLElement>('.cm-code-line') : null
  const lineElement = target && el.contains(target)
    ? target
    : visibleLineElements.reduce<HTMLElement | null>((best, line) => {
      if (!best) return line
      const rect = line.getBoundingClientRect()
      const bestRect = best.getBoundingClientRect()
      return Math.abs(event.clientY - (rect.top + rect.height / 2)) < Math.abs(event.clientY - (bestRect.top + bestRect.height / 2)) ? line : best
    }, null)
  const lineIndex = lineElement ? Math.max(0, visibleLineElements.indexOf(lineElement)) : 0
  const explicitFrom = lineElement ? Number(lineElement.dataset.sourceFrom) : NaN
  const explicitTo = lineElement ? Number(lineElement.dataset.sourceTo) : NaN
  if (lineElement && Number.isFinite(explicitFrom) && Number.isFinite(explicitTo) && explicitTo >= explicitFrom) {
    const lineSource = view.state.doc.sliceString(explicitFrom, explicitTo)
    const range = (document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null
    }).caretRangeFromPoint?.(event.clientX, event.clientY)
    if (range && lineElement.contains(range.startContainer)) {
      const walker = document.createTreeWalker(lineElement, NodeFilter.SHOW_TEXT)
      let offset = 0
      let node: Node | null = walker.nextNode()
      while (node) {
        if (node === range.startContainer) {
          return explicitFrom + Math.min(lineSource.length, offset + range.startOffset)
        }
        offset += node.textContent?.replace(/\u200b$/, '').length ?? 0
        node = walker.nextNode()
      }
    }
    const lineRect = lineElement.getBoundingClientRect()
    const x = event.clientX - lineRect.left + el.scrollLeft
    const ratio = lineRect.width > 0 ? Math.min(1, Math.max(0, x / lineRect.width)) : 0
    return explicitFrom + Math.round(lineSource.length * ratio)
  }
  const sourceLineIndex = Math.min(sourceLines.length - 1, bodyStart + lineIndex)
  const line = sourceLines[sourceLineIndex] ?? ''
  const lineStart = sourceLines.slice(0, sourceLineIndex).reduce((offset, value) => offset + value.length + 1, 0)
  if (lineElement) {
    const range = (document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null
    }).caretRangeFromPoint?.(event.clientX, event.clientY)
    if (range && lineElement.contains(range.startContainer)) {
      const walker = document.createTreeWalker(lineElement, NodeFilter.SHOW_TEXT)
      let offset = 0
      let node: Node | null = walker.nextNode()
      while (node) {
        if (node === range.startContainer) {
          return from + lineStart + Math.min(line.length, offset + range.startOffset)
        }
        offset += node.textContent?.replace(/\u200b$/, '').length ?? 0
        node = walker.nextNode()
      }
    }
    const lineRect = lineElement.getBoundingClientRect()
    const x = event.clientX - lineRect.left + el.scrollLeft
    const availableWidth = Math.max(1, lineRect.width)
    return from + lineStart + Math.round(line.length * Math.min(1, Math.max(0, x / availableWidth)))
  }
  return from + lineStart
}

function isScrollbarInteraction(el: HTMLElement, event: MouseEvent): boolean {
  const rect = el.getBoundingClientRect()
  const x = event.clientX - rect.left
  const y = event.clientY - rect.top
  const hasHorizontalScrollbar = el.scrollWidth > el.clientWidth
  const hasVerticalScrollbar = el.scrollHeight > el.clientHeight
  return (hasHorizontalScrollbar && y >= el.clientHeight)
    || (hasVerticalScrollbar && x >= el.clientWidth)
}

function bindSourcePosition(el: HTMLElement, sourceFrom: number | undefined, sourceTo?: number): void {
  if (sourceFrom === undefined) return
  const end = sourceTo ?? sourceFrom
  el.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return
    if (isScrollbarInteraction(el, event)) {
      // 滚动条属于 widget 自身，不应被 CodeMirror 映射成源码光标位置；
      // 只阻止事件继续冒泡，保留浏览器对滚动条的默认拖动/跳转行为。
      event.stopPropagation()
      return
    }
    const view = EditorView.findFromDOM(el)
    if (!view) return
    event.preventDefault()
    event.stopPropagation()
    view.dispatch({
      selection: { anchor: sourcePositionAtPoint(view, el, event, sourceFrom, end) },
      scrollIntoView: true,
    })
    view.focus()
  })
}

// KaTeX 公式 widget：用于替换行内/块级 LaTeX 源码，显示真正的数学排版。
export class MathWidget extends WidgetType {
  constructor(
    readonly expression: string,
    readonly display: boolean,
    readonly sourceFrom?: number,
    readonly sourceTo?: number,
  ) {
    super()
  }

  eq(other: MathWidget): boolean {
    return other.expression === this.expression && other.display === this.display && other.sourceFrom === this.sourceFrom && other.sourceTo === this.sourceTo
  }

  toDOM(): HTMLElement {
    const el = document.createElement(this.display ? 'div' : 'span')
    el.className = this.display ? 'cm-math cm-math-display' : 'cm-math cm-math-inline'
    bindSourcePosition(el, this.sourceFrom, this.sourceTo)
    try {
      katex.render(normalizeMathExpression(this.expression), el, {
        displayMode: this.display,
        throwOnError: false,
        strict: 'ignore',
        trust: false,
      })
    } catch {
      el.textContent = this.expression
    }
    return el
  }

  // 交给 CodeMirror 处理点击，让渲染后的公式仍可把光标带回对应源码位置。
  ignoreEvent(): boolean {
    return false
  }
}

// 通用符号 widget：用短符号替换 markdown 标记（如列表圆点）。
export class SymbolWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly className: string,
    readonly sourceFrom?: number,
    readonly sourceTo?: number,
  ) {
    super()
  }

  eq(other: SymbolWidget): boolean {
    return other.text === this.text && other.className === this.className && other.sourceFrom === this.sourceFrom && other.sourceTo === this.sourceTo
  }

  toDOM(): HTMLElement {
    const s = document.createElement('span')
    s.className = this.className
    s.textContent = this.text
    bindSourcePosition(s, this.sourceFrom, this.sourceTo)
    return s
  }

  ignoreEvent(): boolean {
    return false
  }
}

export class HorizontalRuleWidget extends WidgetType {
  constructor(
    readonly sourceFrom: number,
    readonly sourceTo: number,
  ) {
    super()
  }

  eq(other: HorizontalRuleWidget): boolean {
    return other.sourceFrom === this.sourceFrom && other.sourceTo === this.sourceTo
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-hr-widget'
    el.setAttribute('role', 'separator')
    bindSourcePosition(el, this.sourceFrom, this.sourceTo)
    return el
  }

  ignoreEvent(): boolean {
    return false
  }
}

export class TaskWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly checkedFrom: number,
    readonly sourceFrom: number,
    readonly sourceTo: number,
  ) {
    super()
  }

  eq(other: TaskWidget): boolean {
    return other.checked === this.checked && other.checkedFrom === this.checkedFrom && other.sourceFrom === this.sourceFrom && other.sourceTo === this.sourceTo
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-task-marker'
    el.setAttribute('role', 'checkbox')
    el.setAttribute('aria-checked', String(this.checked))
    el.tabIndex = 0
    el.textContent = this.checked ? '☑' : '☐'
    const toggle = (event: Event) => {
      const view = EditorView.findFromDOM(el)
      if (!view) return
      event.preventDefault()
      event.stopPropagation()
      view.dispatch({
        changes: { from: this.checkedFrom, to: this.checkedFrom + 1, insert: this.checked ? ' ' : 'x' },
        scrollIntoView: true,
      })
      view.focus()
    }
    el.addEventListener('mousedown', toggle)
    el.addEventListener('keydown', (event) => {
      if (event.key === ' ' || event.key === 'Enter') toggle(event)
    })
    return el
  }

  ignoreEvent(): boolean {
    return false
  }
}

export class TableWidget extends WidgetType {
  constructor(
    readonly rows: TableRow[],
    readonly sourceFrom: number,
    readonly sourceTo: number,
  ) {
    super()
  }

  eq(other: TableWidget): boolean {
    return other.sourceFrom === this.sourceFrom && other.sourceTo === this.sourceTo && JSON.stringify(other.rows) === JSON.stringify(this.rows)
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-table'
    const table = document.createElement('table')
    const head = document.createElement('thead')
    const body = document.createElement('tbody')
    const renderRow = (row: TableRow) => {
      const tr = document.createElement('tr')
      row.cells.forEach((cell, index) => {
        const el = document.createElement(row.header ? 'th' : 'td')
        const alignment = row.alignments[index]
        if (alignment) el.style.textAlign = alignment
        renderTableCell(cell, el)
        tr.appendChild(el)
      })
      return tr
    }
    const headerRow = this.rows[0]
    if (headerRow) head.appendChild(renderRow(headerRow))
    for (const row of this.rows.slice(1)) body.appendChild(renderRow(row))
    table.append(head, body)
    wrap.appendChild(table)
    bindSourcePosition(wrap, this.sourceFrom, this.sourceTo)
    return wrap
  }

  ignoreEvent(): boolean {
    return false
  }
}

export class CodeBlockWidget extends WidgetType {
  constructor(
    readonly content: string,
    readonly language: string,
    readonly sourceFrom: number,
    readonly sourceTo: number,
    readonly sourceLines: readonly CodeLineSourceRange[] = [],
  ) {
    super()
  }

  eq(other: CodeBlockWidget): boolean {
    return other.content === this.content
      && other.language === this.language
      && other.sourceFrom === this.sourceFrom
      && other.sourceTo === this.sourceTo
      && other.sourceLines.length === this.sourceLines.length
      && other.sourceLines.every((line, index) => line.from === this.sourceLines[index]?.from && line.to === this.sourceLines[index]?.to)
  }

  toDOM(): HTMLElement {
    const pre = document.createElement('pre')
    pre.className = 'cm-code-block-widget'
    const code = document.createElement('code')
    if (this.language) code.className = `language-${this.language.replace(/[^a-zA-Z0-9_-]/g, '')}`
    const lines = this.content.split('\n')
    for (const [index, line] of lines.entries()) {
      const lineEl = document.createElement('span')
      lineEl.className = 'cm-code-line'
      lineEl.dataset.lineIndex = String(index)
      const sourceLine = this.sourceLines[index]
      if (sourceLine) {
        lineEl.dataset.sourceFrom = String(sourceLine.from)
        lineEl.dataset.sourceTo = String(sourceLine.to)
      }
      // 空行也占据一个可点击的行高，零宽占位不会改变视觉内容。
      lineEl.textContent = line || '\u200b'
      code.appendChild(lineEl)
      if (index < lines.length - 1) code.appendChild(document.createTextNode('\n'))
    }
    pre.appendChild(code)
    bindSourcePosition(pre, this.sourceFrom, this.sourceTo)
    return pre
  }

  ignoreEvent(): boolean {
    return false
  }
}

// 图片 widget：替换 ![alt](url)，真实渲染 <img>；禁用拖拽等默认行为。
export class ImageWidget extends WidgetType {
  constructor(
    readonly alt: string,
    readonly url: string,
    readonly sourceFrom?: number,
    readonly sourceTo?: number,
  ) {
    super()
  }

  eq(other: ImageWidget): boolean {
    return other.alt === this.alt && other.url === this.url && other.sourceFrom === this.sourceFrom && other.sourceTo === this.sourceTo
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'cm-image'
    const safeUrl = safeImageUrl(this.url)
    if (safeUrl) {
      const img = document.createElement('img')
      img.src = safeUrl
      img.alt = this.alt
      img.loading = 'lazy'
      img.decoding = 'async'
      img.referrerPolicy = 'no-referrer'
      wrap.appendChild(img)
    } else {
      wrap.textContent = this.alt || '[图片地址无效]'
    }
    bindSourcePosition(wrap, this.sourceFrom, this.sourceTo)
    return wrap
  }

  ignoreEvent(): boolean {
    return false
  }
}
