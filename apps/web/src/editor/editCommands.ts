// 工具栏编辑命令的纯计算部分（无 view/DOM 依赖），便于单元测试。
export interface EditResult {
  text: string
  selFrom: number
  selTo: number
}

// 计算“在选区周围包裹 before/after”后的文本与选区。
export function computeInsertAround(
  text: string,
  from: number,
  to: number,
  before: string,
  after: string,
  placeholderText: string,
): EditResult {
  const selected = from === to ? placeholderText : text.slice(from, to)
  const selFrom = from + before.length
  const selTo = selFrom + selected.length
  return {
    text: text.slice(0, from) + before + selected + after + text.slice(to),
    selFrom,
    selTo,
  }
}

// 计算“给选中所在的整行加前缀”后的文本与选区。
export function computePrefixLines(text: string, from: number, to: number, prefix: string): EditResult {
  const start = text.lastIndexOf('\n', Math.max(0, from - 1)) + 1
  const nextBreak = text.indexOf('\n', to)
  const end = nextBreak === -1 ? text.length : nextBreak
  const selected = text.slice(start, end)
  const replacement = selected
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n')
  return {
    text: text.slice(0, start) + replacement + text.slice(end),
    selFrom: start,
    selTo: start + replacement.length,
  }
}