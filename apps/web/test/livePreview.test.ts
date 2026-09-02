import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Text } from '@codemirror/state'
import { parseMarkdown } from '../src/editor/markdownTokens'
import { activeLineNumbers, tokensToRender } from '../src/editor/livePreview'
import { computeInsertAround, computePrefixLines } from '../src/editor/editCommands'

// 工具：构造只覆盖单个位置的“选区”。
const sel = (pos: number) => ({ from: pos, to: pos }) as never

test('光标在粗体行时：该行保留源码（不隐藏标记）', () => {
  const doc = Text.of(['**粗体**', '普通'])
  const tokens = parseMarkdown(doc.toString())
  const strong = tokens.find((t) => t.kind === 'strong')
  assert.ok(strong)
  const active = activeLineNumbers(doc, [sel(0)])
  assert.ok(active.has(1))
  assert.equal(tokensToRender(doc, [strong!], active).length, 0)
})

test('光标离开后：粗体行渲染（隐藏标记）', () => {
  const doc = Text.of(['**粗体**', '普通'])
  const tokens = parseMarkdown(doc.toString())
  const strong = tokens.find((t) => t.kind === 'strong')!
  const active = activeLineNumbers(doc, [sel(doc.line(2).from)])
  assert.ok(!active.has(1))
  assert.equal(tokensToRender(doc, [strong], active).length, 1)
})

test('多行内容中光标位置保持正确（选区跨行时都显示源码）', () => {
  const doc = Text.of(['# 标题', '**粗体**', '## 标题二', '普通'])
  const tokens = parseMarkdown(doc.toString())
  const line2 = doc.line(2).from
  const line3 = doc.line(3).from
  const active = activeLineNumbers(doc, [{ from: line2, to: line3 }] as never)
  assert.ok(active.has(2))
  assert.ok(active.has(3))
  const headings = tokens.filter((t) => t.kind === 'heading')
  const rendered = tokensToRender(doc, headings, active)
  // 第 3 行的标题处于活动行，不应被渲染；第 1 行的标题应被渲染。
  assert.equal(rendered.some((t) => t.kind === 'heading' && t.level === 1), true)
  assert.equal(rendered.some((t) => t.kind === 'heading' && t.level === 2), false)
})

test('内容编辑：包裹选区（加粗）不会丢失其它内容', () => {
  const r = computeInsertAround('前面 文字 后面', 3, 5, '**', '**', '粗体')
  assert.equal(r.text, '前面 **文字** 后面')
  assert.equal(r.selFrom, 5)
  assert.equal(r.selTo, 7)
})

test('内容编辑：无选区时使用占位文字', () => {
  const r = computeInsertAround('abc', 1, 1, '*', '*', '斜体文字')
  assert.equal(r.text, 'a*斜体文字*bc')
  assert.equal(r.selFrom, 2)
  assert.equal(r.selTo, 6)
})

test('内容编辑：给选中行加前缀（标题/列表）', () => {
  const r = computePrefixLines('第一行\n第二行\n第三行', 4, 7, '## ')
  assert.equal(r.text, '第一行\n## 第二行\n第三行')
})

test('内容编辑：代码块包裹选区', () => {
  const r = computeInsertAround('x', 0, 1, '```\n', '\n```', '代码')
  assert.equal(r.text, '```\nx\n```')
})