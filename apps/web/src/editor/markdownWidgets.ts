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

function bindSourcePosition(el: HTMLElement, sourceFrom: number | undefined, sourceTo?: number): void {
  if (sourceFrom === undefined) return
  const end = sourceTo ?? sourceFrom
  el.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return
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
  ) {
    super()
  }

  eq(other: CodeBlockWidget): boolean {
    return other.content === this.content && other.language === this.language && other.sourceFrom === this.sourceFrom && other.sourceTo === this.sourceTo
  }

  toDOM(): HTMLElement {
    const pre = document.createElement('pre')
    pre.className = 'cm-code-block-widget'
    const code = document.createElement('code')
    if (this.language) code.className = `language-${this.language.replace(/[^a-zA-Z0-9_-]/g, '')}`
    code.textContent = this.content
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
