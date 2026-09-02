// 为 Markdown 预处理生成不会和用户正文冲突的纯文本占位符。
// 占位符只使用字母和数字，避免被 Markdown 解析器当成强调/链接标记。
export function createUniquePlaceholder(prefix: string, source: string, used: Set<string>): string {
  let index = 0
  let candidate = ''
  do {
    candidate = `${prefix}${index++}X`
  } while (source.includes(candidate) || used.has(candidate))
  used.add(candidate)
  return candidate
}
