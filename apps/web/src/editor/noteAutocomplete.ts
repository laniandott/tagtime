import { type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { api } from '../api'

// `[[` 笔记自动补全：基于 CodeMirror 6 autocompletion，异步查询后端。
export function noteCompletionSource(
  ctx: CompletionContext,
): CompletionResult | null | Promise<CompletionResult | null> {
  const match = ctx.matchBefore(/\[\[([^\[\]\n]*)$/)
  if (!match) return null
  const word = match.text.slice(2)
  return new Promise<CompletionResult | null>((resolve) => {
    api.notes
      .autocomplete(word)
      .then((entries) => {
        resolve({
          from: match.from,
          options: entries.map((e) => ({
            label: e.title,
            detail: e.path,
            apply: `[[${e.title}]]`,
          })),
        })
      })
      .catch(() => resolve(null))
  })
}