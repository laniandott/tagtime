// 返回 Markdown 文档中 fenced/inline code 的源码区间。
// 未闭合的 fenced code 按 Markdown 编辑器语义保护到文档末尾。
export function codeRanges(source: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  for (const match of source.matchAll(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g)) {
    ranges.push([match.index ?? 0, (match.index ?? 0) + match[0].length])
  }
  for (const match of source.matchAll(/`[^`\n]*`/g)) {
    const start = match.index ?? 0
    if (!ranges.some(([from, to]) => start >= from && start < to)) {
      ranges.push([start, start + match[0].length])
    }
  }
  return ranges
}
