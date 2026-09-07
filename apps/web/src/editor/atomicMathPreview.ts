import { RangeSetBuilder, StateField, type EditorState } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view'
import katex from 'katex'
import { normalizeMathExpression, parseMarkdown } from './markdownTokens'

class MathWidget extends WidgetType {
  constructor(readonly expression: string, readonly display: boolean) { super() }

  eq(other: MathWidget): boolean {
    return other.expression === this.expression && other.display === this.display
  }

  toDOM(): HTMLElement {
    const element = document.createElement(this.display ? 'div' : 'span')
    element.className = this.display ? 'tagtime-atomic-math tagtime-atomic-math-display' : 'tagtime-atomic-math'
    try {
      katex.render(normalizeMathExpression(this.expression), element, {
        displayMode: this.display,
        throwOnError: false,
        strict: 'ignore',
        trust: false,
      })
    } catch {
      element.textContent = this.expression
    }
    return element
  }

  ignoreEvent(): boolean { return false }
}

function isActive(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((selection) => selection.from <= to && selection.to >= from)
}

function buildMathDecorations(state: EditorState): DecorationSet {
  const builder: Array<{ from: number; to: number; decoration: Decoration }> = []
  // ponytail: reparse only the small math subset; keep the package's syntax tree for all other Markdown.
  for (const token of parseMarkdown(state.doc.toString())) {
    if (token.kind !== 'math' || isActive(state, token.from, token.to)) continue
    builder.push({
      from: token.from,
      to: token.to,
      decoration: Decoration.replace({
        widget: new MathWidget(token.expression, token.display),
        block: token.display,
      }),
    })
  }
  builder.sort((a, b) => a.from - b.from)
  const decorations = new RangeSetBuilder<Decoration>()
  for (const entry of builder) decorations.add(entry.from, entry.to, entry.decoration)
  return decorations.finish()
}

export const atomicMathPreview = StateField.define<DecorationSet>({
  create: buildMathDecorations,
  update(value, transaction) {
    return transaction.docChanged || transaction.selection ? buildMathDecorations(transaction.state) : value
  },
  provide: (field) => EditorView.decorations.from(field),
})
