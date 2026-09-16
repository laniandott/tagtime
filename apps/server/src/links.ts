// 双向链接语法解析：[[标题]] 与 [[标题|别名]]，在服务端执行
export interface ParsedLink {
  targetTitle: string
  linkText: string
  targetKey: string
}

// TagTime 深度关联的特殊链接：[[tag:工作]] / [[todo:购买设备]] / [[date:2026-08-31]] / [[memo:<id>]]
export type EntityLinkType = 'tag' | 'todo' | 'date' | 'memo'
export const ENTITY_PREFIXES: Record<string, EntityLinkType> = {
  tag: 'tag',
  todo: 'todo',
  date: 'date',
  memo: 'memo',
}

export interface ParsedEntityLink {
  type: EntityLinkType
  entityKey: string // tag:标签名, todo:标题, date:YYYY-MM-DD, memo:日记id
  linkText: string
}

// 判断某个规范化后的目标键是否命中 TagTime 特殊链接前缀（避免同时污染普通 NoteLink）
export function isEntityLinkKey(targetKey: string): boolean {
  const i = targetKey.indexOf(':')
  if (i <= 0) return false
  const prefix = targetKey.slice(0, i).toLowerCase().trim()
  return prefix in ENTITY_PREFIXES
}

// 规范化标题：trim + 合并连续空白 + 统一小写，作为链接解析的唯一键
export function normalizeTitleKey(title: string): string {
  return title
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

function splitAlias(raw: string): [string, string] {
  const i = raw.indexOf('|')
  if (i === -1) return [raw.trim(), '']
  return [raw.slice(0, i).trim(), raw.slice(i + 1).trim()]
}

// 解析正文中的 [[...]] 链接，忽略 fenced code block、行内代码和转义的 \[[
export function parseLinks(content: string): ParsedLink[] {
  const results: ParsedLink[] = []
  const re = /\[\[([^\[\]]+)\]\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(sanitizeContent(content))) !== null) {
    const raw = m[1].trim()
    if (!raw || raw.includes('\u0000')) continue
    const [targetTitle, linkText] = splitAlias(raw)
    const targetKey = normalizeTitleKey(targetTitle)
    if (targetKey) {
      results.push({ targetTitle, linkText, targetKey })
    }
  }
  return results
}

// 解析正文中的特殊关联链接：[[tag:... / todo:... / date:... / memo:...]]
export function parseEntityLinks(content: string): ParsedEntityLink[] {
  const results: ParsedEntityLink[] = []
  const re = /\[\[([^\[\]]+)\]\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(sanitizeContent(content))) !== null) {
    const raw = m[1].trim()
    if (!raw || raw.includes('\u0000')) continue
    const idx = raw.indexOf(':')
    if (idx <= 0) continue
    const prefix = raw.slice(0, idx).toLowerCase().trim()
    const type = ENTITY_PREFIXES[prefix]
    if (!type) continue
    const rest = raw.slice(idx + 1).trim()
    if (!rest) continue
    // 别名：[[type:key|别名]]
    const keyText = rest.split('|').map((s) => s.trim())
    const entityKey = keyText[0].split(' ').join(' ').trim()
    if (!entityKey) continue
    results.push({ type, entityKey, linkText: keyText[1] ?? '' })
  }
  return results
}

// 剔除 fenced code block、行内代码并把转义的 \[[ 标记为不可匹配
function sanitizeContent(content: string): string {
  return content
    .replace(/```[\s\S]*?(?:```|$)/g, '') // fenced code block
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, '')
    .replace(/`[^`\n]*`/g, '') // 行内代码
    .replace(/\\\[\[/g, '\u0000') // 转义的 [[ 标记为不可匹配
}