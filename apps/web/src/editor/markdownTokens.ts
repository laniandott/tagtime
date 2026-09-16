// 轻量 Markdown 解析器：把文档拆成可渲染的 token（块级 + 行内 + 公式 + 代码块）。
// 只做“识别语法边界”，不负责拼 HTML；装饰器(livePreviewPlugin)据此隐藏标记 / 加样式 / 挂 widget。
// 纯函数，不依赖 DOM，便于单元测试。

export type Token =
  | { kind: 'heading'; from: number; to: number; markerFrom: number; markerTo: number; level: number }
  | { kind: 'blockquote'; from: number; to: number; markerFrom: number; markerTo: number }
  | {
      kind: 'list'
      from: number
      to: number
      markerFrom: number
      markerTo: number
      markerText: string
      listType: 'bullet' | 'ordered' | 'task'
      checked?: boolean
      checkedFrom?: number
    }
  | { kind: 'table'; from: number; to: number; rows: TableRow[] }
  | { kind: 'hr'; from: number; to: number }
  | { kind: 'fence'; from: number; to: number; marker: string; language: string; content: string }
  | { kind: 'strong'; from: number; to: number; contentFrom: number; contentTo: number }
  | { kind: 'em'; from: number; to: number; contentFrom: number; contentTo: number }
  | { kind: 'strike'; from: number; to: number; contentFrom: number; contentTo: number }
  | { kind: 'inlineCode'; from: number; to: number; contentFrom: number; contentTo: number }
  | { kind: 'link'; from: number; to: number; textFrom: number; textTo: number; url: string }
  | { kind: 'image'; from: number; to: number; alt: string; url: string }
  | { kind: 'wikilink'; from: number; to: number; contentFrom: number; contentTo: number }
  | { kind: 'math'; from: number; to: number; display: boolean; expression: string }

type Range = [number, number]

export interface TableRow {
  cells: string[]
  header: boolean
  alignments: Array<'left' | 'center' | 'right' | null>
}

interface LineInfo {
  text: string
  start: number
  end: number
}

function inRange(pos: number, ranges: Range[]): boolean {
  return ranges.some(([from, to]) => pos >= from && pos < to)
}

function linesOf(src: string): LineInfo[] {
  const lines = src.split('\n')
  const out: LineInfo[] = []
  let cursor = 0
  for (const text of lines) {
    out.push({ text, start: cursor, end: cursor + text.length })
    cursor += text.length + 1
  }
  return out
}

// 识别行内与块级公式
const DISPLAY_MATH_RE = /\\\[[\s\S]*?\\\]|\$\$[\s\S]*?\$\$/g
const INLINE_MATH_RE = /\\\([^\n]*?\\\)|\$[^$\n]+?\$/g

const FENCE_OPEN_RE = /^[ \t]{0,3}(`{3,}|~{3,})/
const FENCE_CLOSE_RE = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/

function codeFenceRanges(src: string): Array<{ range: [number, number]; marker: string }> {
  const ranges: Array<{ range: [number, number]; marker: string }> = []
  const lines = linesOf(src)
  let open: { start: number; marker: string } | null = null
  for (const line of lines) {
    if (open) {
      const close = FENCE_CLOSE_RE.exec(line.text)
      const isClose = close && close[1][0] === open.marker[0] && close[1].length >= open.marker.length
      if (isClose) {
        ranges.push({ range: [open.start, line.end], marker: open.marker })
        open = null
      }
      continue
    }
    const m = FENCE_OPEN_RE.exec(line.text)
    if (m) open = { start: line.start, marker: m[1] }
  }
  if (open) ranges.push({ range: [open.start, src.length], marker: open.marker })
  return ranges
}

function splitTableCells(text: string): string[] {
  let source = text.trim()
  if (source.startsWith('|')) source = source.slice(1)
  if (source.endsWith('|') && !source.endsWith('\\|')) source = source.slice(0, -1)
  const cells: string[] = []
  let current = ''
  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    if (char === '\\' && source[i + 1] === '|') {
      current += '|'
      i++
    } else if (char === '|') {
      cells.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  cells.push(current.trim())
  return cells
}

function tableAlignments(cells: string[]): Array<'left' | 'center' | 'right' | null> | null {
  if (cells.length < 2 || !cells.every((cell) => /^:?-{3,}:?$/.test(cell))) return null
  return cells.map((cell) => {
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    return left && right ? 'center' : right ? 'right' : left ? 'left' : null
  })
}

function tableRow(line: LineInfo, header: boolean, alignments: Array<'left' | 'center' | 'right' | null>): TableRow | null {
  if (!line.text.includes('|')) return null
  const cells = splitTableCells(line.text)
  if (cells.length !== alignments.length) return null
  return { cells, header, alignments }
}

export function normalizeMathExpression(expression: string): string {
  return expression.replace(/\\_/g, '_').trim()
}

export function parseMarkdown(src: string): Token[] {
  const tokens: Token[] = []
  const protectedRanges: Range[] = []

  // 1) fenced code blocks（内部不再解析）
  const fences = codeFenceRanges(src)
  for (const f of fences) {
    protectedRanges.push(f.range)
    const raw = src.slice(f.range[0], f.range[1])
    const fenceLines = raw.split('\n')
    const opening = fenceLines[0].trim()
    const language = opening.slice(f.marker.length).trim()
    const hasClosing = fenceLines.length > 1 && new RegExp(`^${f.marker[0]}{${f.marker.length},}[ \\t]*$`).test(fenceLines[fenceLines.length - 1].trim())
    const bodyLines = hasClosing ? fenceLines.slice(1, -1) : fenceLines.slice(1)
    tokens.push({ kind: 'fence', from: f.range[0], to: f.range[1], marker: f.marker, language, content: bodyLines.join('\n') })
  }

  // 2) display math（$$...$$、\[...\]），排除出现在代码块内的
  const displayMatches: RegExpExecArray[] = []
  {
    const re = new RegExp(DISPLAY_MATH_RE.source, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) displayMatches.push(m)
  }
  for (const m of displayMatches) {
    const from = m.index
    const to = from + m[0].length
    if (inRange(from, protectedRanges)) continue
    const raw = m[0]
    const display = raw.startsWith('$$') || raw.startsWith('\\[')
    const expression = display ? raw.slice(2, -2) : raw.slice(1, -1)
    protectedRanges.push([from, to])
    tokens.push({ kind: 'math', from, to, display: true, expression })
  }

  // 3) 识别 GFM 表格，并把整个表格作为一个块替换，保证列宽可以统一对齐。
  const lines = linesOf(src)
  for (let i = 0; i + 1 < lines.length; i++) {
    const header = lines[i]
    const separator = lines[i + 1]
    if (inRange(header.start, protectedRanges) || inRange(separator.start, protectedRanges)) continue
    const headerCells = splitTableCells(header.text)
    const alignments = tableAlignments(splitTableCells(separator.text))
    if (headerCells.length < 2 || !alignments) continue
    const rows: TableRow[] = [{ cells: headerCells, header: true, alignments }]
    let end = separator.end
    let j = i + 2
    while (j < lines.length) {
      const line = lines[j]
      if (line.text.trim() === '' || inRange(line.start, protectedRanges)) break
      const row = tableRow(line, false, alignments)
      if (!row) break
      rows.push(row)
      end = line.end
      j++
    }
    protectedRanges.push([header.start, end])
    tokens.push({ kind: 'table', from: header.start, to: end, rows })
    i = j - 1
  }

  // 4) 逐行处理非受保护区间的块级与行内语法
  for (const line of lines) {
    if (line.text.length === 0) continue
    if (inRange(line.start, protectedRanges)) continue
    parseLine(line.text, line.start, tokens, protectedRanges)
  }

  return tokens
}

// 逐行解析：块级标记（标题/列表/引用/分隔线）+ 行内（公式/代码/链接/强调）
function parseLine(text: string, base: number, tokens: Token[], protectedRanges: Range[]): void {
  // 标题
  const heading = /^(\s{0,3})(#{1,6})(?=\s)/.exec(text)
  if (heading) {
    const hashLen = heading[2].length
    const markerFrom = base + heading[1].length
    tokens.push({ kind: 'heading', from: base, to: base + text.length, markerFrom, markerTo: markerFrom + hashLen, level: hashLen })
    parseInline(text, base, tokens, protectedRanges)
    return
  }

  // 分隔线
  if (/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(text)) {
    tokens.push({ kind: 'hr', from: base, to: base + text.length })
    return
  }

  // 引用
  const quote = /^(\s{0,3}>\s?)/.exec(text)
  if (quote) {
    tokens.push({ kind: 'blockquote', from: base, to: base + text.length, markerFrom: base, markerTo: base + quote[0].length })
    parseInline(text, base, tokens, protectedRanges)
    return
  }

  // 任务列表（先于普通列表）
  const task = /^(\s*)([-*+])\s+(\[([ xX])\])\s+/.exec(text)
  if (task) {
    tokens.push({
      kind: 'list',
      from: base,
      to: base + text.length,
      markerFrom: base,
      markerTo: base + task[0].length,
      markerText: task[2],
      listType: 'task',
      checked: task[4].toLowerCase() === 'x',
      checkedFrom: base + task[0].indexOf(task[3]) + 1,
    })
    parseInline(text, base, tokens, protectedRanges)
    return
  }

  // 无序列表
  const bullet = /^(\s*)([-*+])\s+/.exec(text)
  if (bullet) {
    tokens.push({
      kind: 'list',
      from: base,
      to: base + text.length,
      markerFrom: base,
      markerTo: base + bullet[0].length,
      markerText: bullet[2],
      listType: 'bullet',
    })
    parseInline(text, base, tokens, protectedRanges)
    return
  }

  // 有序列表
  const ordered = /^(\s*)(\d{1,9}[.)])\s+/.exec(text)
  if (ordered) {
    tokens.push({
      kind: 'list',
      from: base,
      to: base + text.length,
      markerFrom: base,
      markerTo: base + ordered[0].length,
      markerText: ordered[2],
      listType: 'ordered',
    })
    parseInline(text, base, tokens, protectedRanges)
    return
  }

  parseInline(text, base, tokens, protectedRanges)
}

// 行内解析：识别行内代码、公式、图片、链接、wiki 链接、强调/删除线。
// 核心技巧：每识别一个片段就用等长空白“占位”，保证坐标不变，也避免外层正则误命中内层。
function parseInline(text: string, base: number, tokens: Token[], protectedRanges: Range[]): void {
  let buf = text

  const blank = (from: number, to: number) => {
    buf = buf.slice(0, from) + ' '.repeat(to - from) + buf.slice(to)
  }
  const abs = (idx: number) => base + idx

  // 块级公式可能与普通文字出现在同一行（例如“说明 $$x$$”）。
  // 先把已经识别过的受保护区间置空，避免行内公式正则再次命中并产生重叠装饰。
  for (const [from, to] of protectedRanges) {
    const localFrom = Math.max(0, from - base)
    const localTo = Math.min(text.length, to - base)
    if (localTo > localFrom) blank(localFrom, localTo)
  }

  // 1) 先保护行内代码，避免代码中的 `$...$` 被识别成公式。
  {
    const re = /`[^`\n]+`/g
    let m: RegExpExecArray | null
    while ((m = re.exec(buf))) {
      const from = m.index
      const to = from + m[0].length
      tokens.push({ kind: 'inlineCode', from: abs(from), to: abs(to), contentFrom: abs(from + 1), contentTo: abs(to - 1) })
      blank(from, to)
    }
  }

  // 2) 行内公式
  {
    const re = new RegExp(INLINE_MATH_RE.source, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(buf))) {
      const from = m.index
      const to = from + m[0].length
      const raw = m[0]
      const display = raw.startsWith('\\(')
      const expression = display ? raw.slice(2, -2) : raw.slice(1, -1)
      tokens.push({ kind: 'math', from: abs(from), to: abs(to), display: false, expression })
      blank(from, to)
    }
  }

  // 3) 图片、链接（图片在链接前，避免 ! 前缀被当普通链接）
  {
    const imgRe = /!\[([^\[\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g
    let m: RegExpExecArray | null
    const imgMatches: RegExpExecArray[] = []
    while ((m = imgRe.exec(buf))) imgMatches.push(m)
    for (const mm of imgMatches) {
      const from = mm.index
      const to = from + mm[0].length
      tokens.push({ kind: 'image', from: abs(from), to: abs(to), alt: mm[1], url: mm[2] })
      blank(from, to)
    }
  }
  {
    const linkRe = /\[([^\[\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g
    let m: RegExpExecArray | null
    const linkMatches: RegExpExecArray[] = []
    while ((m = linkRe.exec(buf))) linkMatches.push(m)
    for (const mm of linkMatches) {
      const from = mm.index
      const to = from + mm[0].length
      const label = mm[1]
      tokens.push({ kind: 'link', from: abs(from), to: abs(to), textFrom: abs(from + 1), textTo: abs(from + 1 + label.length), url: mm[2] })
      blank(from, to)
    }
  }

  // 4) wiki 链接 [[...]]
  {
    const re = /\[\[([^\[\]\n]+)\]\]/g
    let m: RegExpExecArray | null
    const matches: RegExpExecArray[] = []
    while ((m = re.exec(buf))) matches.push(m)
    for (const mm of matches) {
      const from = mm.index
      const to = from + mm[0].length
      const label = mm[1]
      tokens.push({ kind: 'wikilink', from: abs(from), to: abs(to), contentFrom: abs(from + 2), contentTo: abs(from + 2 + label.length) })
      blank(from, to)
    }
  }

  // 5) 强调/删除线：先 strong/strike，再 em
  {
    const re = /\*\*([^*\n]+?)\*\*/g
    let m: RegExpExecArray | null
    const matches: RegExpExecArray[] = []
    while ((m = re.exec(buf))) matches.push(m)
    for (const mm of matches) {
      const from = mm.index
      const to = from + mm[0].length
      const label = mm[1]
      tokens.push({ kind: 'strong', from: abs(from), to: abs(to), contentFrom: abs(from + 2), contentTo: abs(from + 2 + label.length) })
      blank(from, to)
    }
  }
  {
    const re = /~~([^~\n]+?)~~/g
    let m: RegExpExecArray | null
    const matches: RegExpExecArray[] = []
    while ((m = re.exec(buf))) matches.push(m)
    for (const mm of matches) {
      const from = mm.index
      const to = from + mm[0].length
      const label = mm[1]
      tokens.push({ kind: 'strike', from: abs(from), to: abs(to), contentFrom: abs(from + 2), contentTo: abs(from + 2 + label.length) })
      blank(from, to)
    }
  }
  {
    const re = /\*([^*\n]+?)\*/g
    let m: RegExpExecArray | null
    const matches: RegExpExecArray[] = []
    while ((m = re.exec(buf))) matches.push(m)
    for (const mm of matches) {
      const from = mm.index
      const to = from + mm[0].length
      const label = mm[1]
      tokens.push({ kind: 'em', from: abs(from), to: abs(to), contentFrom: abs(from + 1), contentTo: abs(from + 1 + label.length) })
      blank(from, to)
    }
  }
}
