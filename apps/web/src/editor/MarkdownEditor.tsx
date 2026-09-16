import { useEffect, useRef, useMemo } from 'react'
import { Annotation, EditorState, Compartment } from '@codemirror/state'
import {
  EditorView,
  keymap,
  placeholder as cmPlaceholder,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { livePreviewPlugin } from './livePreviewPlugin'
import { noteCompletionSource } from './noteAutocomplete'
import { computeInsertAround, computePrefixLines } from './editCommands'

export type EditorMode = 'live' | 'source'

interface MarkdownEditorProps {
  value: string
  mode: EditorMode
  onChange?: (value: string) => void
  editorRef?: React.MutableRefObject<EditorView | null>
  placeholderText?: string
  autoFocus?: boolean
  className?: string
}

const liveCompartment = new Compartment()
const externalSync = Annotation.define<boolean>()

export default function MarkdownEditor({
  value,
  mode,
  onChange,
  editorRef,
  placeholderText = '支持 Markdown，输入 [[ 可引用其它笔记',
  autoFocus = true,
  className = '',
}: MarkdownEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const lastEmittedRef = useRef(value)

  // 创建 EditorView（仅一次）
  useEffect(() => {
    if (!containerRef.current) return

    const extensions = [
      history(),
      keymap.of([...completionKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
      markdown({ base: markdownLanguage }),
      syntaxHighlighting(defaultHighlightStyle),
      EditorView.lineWrapping,
      autocompletion({ override: [noteCompletionSource] }),
      cmPlaceholder(placeholderText),
      liveCompartment.of(mode === 'live' ? livePreviewPlugin : []),
      EditorView.updateListener.of((u) => {
        const isExternalSync = u.transactions.some((tr) => tr.annotation(externalSync) === true)
        if (u.docChanged && !isExternalSync) {
          const next = u.state.doc.toString()
          lastEmittedRef.current = next
          onChangeRef.current?.(next)
        }
      }),
    ]

    const view = new EditorView({
      state: EditorState.create({ doc: value, extensions }),
      parent: containerRef.current,
    })
    viewRef.current = view
    if (editorRef) editorRef.current = view
    if (autoFocus) view.focus()

    return () => {
      view.destroy()
      viewRef.current = null
      if (editorRef) editorRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 外部值变更 → 同步进编辑器（服务器加载/丢弃本地等场景）
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const cur = view.state.doc.toString()
    if (value !== cur && value !== lastEmittedRef.current) {
      lastEmittedRef.current = value
      view.dispatch({
        changes: { from: 0, to: cur.length, insert: value },
        annotations: externalSync.of(true),
      })
    }
  }, [value])

  // 模式切换 → 重新配置 live 装饰
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: liveCompartment.reconfigure(mode === 'live' ? livePreviewPlugin : []) })
  }, [mode])

  return <div ref={containerRef} className={`tagtime-editor ${className}`} />
}

// 供工具栏调用的命令（作用于 EditorView），保持与旧 textarea 实现一致的行为。

export function insertAroundSelection(
  view: EditorView,
  before: string,
  after: string,
  placeholderText: string,
): void {
  const { from, to } = view.state.selection.main
  const result = computeInsertAround(view.state.doc.toString(), from, to, before, after, placeholderText)
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: result.text },
    selection: { anchor: result.selFrom, head: result.selTo },
  })
  view.focus()
}

export function prefixSelectedLines(view: EditorView, prefix: string): void {
  const { from, to } = view.state.selection.main
  const result = computePrefixLines(view.state.doc.toString(), from, to, prefix)
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: result.text },
    selection: { anchor: result.selFrom, head: result.selTo },
  })
  view.focus()
}

export function insertTextAtCursor(view: EditorView, text: string): void {
  const { head } = view.state.selection.main
  view.dispatch({ changes: { from: head, to: head, insert: text } })
  view.focus()
}
