import { marked } from 'marked'
import katex from 'katex'
import DOMPurify from 'dompurify'
import { codeRanges } from './codeRanges'
import { createUniquePlaceholder } from './placeholders'
import { normalizeMathExpression } from './markdownTokens'

function isInsideRange(position: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([start, end]) => position >= start && position < end)
}

/** Render Markdown for the standalone preview pane. Source text remains the only editable value. */
export function renderMarkdown(content: string): string {
  const source = content || ''
  const ranges = codeRanges(source)
  const mathTokens: Array<{ token: string; html: string; display: boolean }> = []
  const usedPlaceholders = new Set<string>()
  const mathPattern = /\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$\$[\s\S]*?\$\$|\$[^\n$]+?\$/g
  const markdown = source.replace(mathPattern, (full, offset: number) => {
    if (isInsideRange(offset, ranges)) return full
    const display = full.startsWith('$$') || full.startsWith('\\[')
    const expression = display
      ? full.startsWith('$$') ? full.slice(2, -2) : full.slice(2, -2)
      : full.startsWith('\\(') ? full.slice(2, -2) : full.slice(1, -1)
    const token = createUniquePlaceholder('TAGTIMEMATH', source, usedPlaceholders)
    const html = katex.renderToString(normalizeMathExpression(expression), {
      displayMode: display,
      throwOnError: false,
      strict: 'ignore',
      trust: false,
    })
    mathTokens.push({ token, html, display })
    return token
  })
  let html = marked.parse(markdown, { async: false, breaks: true }) as string
  for (const { token, html: mathHtml, display } of mathTokens) {
    const rendered = display ? mathHtml : `<span class="math-inline">${mathHtml}</span>`
    html = html.replace(new RegExp(`<p>\\s*${token}\\s*</p>`, 'g'), display ? mathHtml : rendered)
    html = html.replaceAll(token, rendered)
  }
  return DOMPurify.sanitize(html)
}
