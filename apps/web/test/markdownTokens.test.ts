import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMarkdown, normalizeMathExpression } from '../src/editor/markdownTokens'
import { codeRanges } from '../src/editor/codeRanges'
import { createUniquePlaceholder } from '../src/editor/placeholders'

test('normalizeMathExpression 还原转义下划线', () => {
  assert.equal(normalizeMathExpression('w\\_1^2'), 'w_1^2')
  assert.equal(normalizeMathExpression('  \\_x  '), '_x')
})

test('Markdown 预处理占位符不会覆盖用户同名文本', () => {
  const used = new Set<string>()
  const source = '正文 TAGTIMEMATH0X 与 TAGTIMETABLEMATH0X'
  const math = createUniquePlaceholder('TAGTIMEMATH', source, used)
  const table = createUniquePlaceholder('TAGTIMETABLEMATH', source, used)
  assert.notEqual(math, 'TAGTIMEMATH0X')
  assert.notEqual(table, 'TAGTIMETABLEMATH0X')
  assert.notEqual(math, table)
})

test('标题：识别级别与标记范围', () => {
  const tokens = parseMarkdown('### 标题')
  const h = tokens.find((t) => t.kind === 'heading')
  assert.ok(h)
  if (h?.kind === 'heading') {
    assert.equal(h.level, 3)
    assert.equal(h.markerFrom, 0)
    assert.equal(h.markerTo, 3)
  }
})

test('缩进标题：标记范围不吞掉前导空格', () => {
  const h = parseMarkdown('  ## 标题').find((t) => t.kind === 'heading')
  assert.ok(h)
  if (h?.kind === 'heading') {
    assert.equal(h.markerFrom, 2)
    assert.equal(h.markerTo, 4)
  }
})

test('粗体 / 斜体 / 删除线', () => {
  const tokens = parseMarkdown('前缀 **粗体** 和 *斜体* 与 ~~删除~~')
  const kinds = tokens.filter((t) => ['strong', 'em', 'strike'].includes(t.kind)).map((t) => t.kind)
  assert.equal(kinds.length, 3)
  assert.ok(kinds.includes('strong'))
  assert.ok(kinds.includes('em'))
  assert.ok(kinds.includes('strike'))
})

test('无序 / 有序 / 任务列表', () => {
  const bullet = parseMarkdown('- 项').find((t) => t.kind === 'list')
  const ordered = parseMarkdown('12. 项').find((t) => t.kind === 'list')
  const task = parseMarkdown('- [x] 任务').find((t) => t.kind === 'list')
  assert.equal(bullet?.listType, 'bullet')
  assert.equal(ordered?.listType, 'ordered')
  assert.equal(task?.listType, 'task')
  if (ordered?.kind === 'list') assert.equal(ordered.markerText, '12.')
  if (task?.kind === 'list') assert.equal(task.checked, true)
  if (task?.kind === 'list') assert.equal(task.checkedFrom, 3)
})

test('GFM 表格识别表头、对齐方式和数据行', () => {
  const table = parseMarkdown('| 名称 | 数值 | 备注 |\n| :--- | ---: | :---: |\n| A | 10 | ok |').find((t) => t.kind === 'table')
  assert.ok(table)
  if (table?.kind === 'table') {
    assert.equal(table.rows.length, 2)
    assert.deepEqual(table.rows[0]?.cells, ['名称', '数值', '备注'])
    assert.deepEqual(table.rows[0]?.alignments, ['left', 'right', 'center'])
    assert.deepEqual(table.rows[1]?.cells, ['A', '10', 'ok'])
  }
})

test('引用块', () => {
  assert.ok(parseMarkdown('> 引用').some((t) => t.kind === 'blockquote'))
})

test('行内代码与 fenced 代码块', () => {
  assert.ok(parseMarkdown('`code`').some((t) => t.kind === 'inlineCode'))
  assert.ok(!parseMarkdown('`$x$`').some((t) => t.kind === 'math'))
  const f = parseMarkdown('```\nprint(1)\n```').find((t) => t.kind === 'fence')
  assert.ok(f)
  if (f?.kind === 'fence') {
    assert.equal(f.language, '')
    assert.equal(f.content, 'print(1)')
  }
})

test('链接 / 图片 / wiki 链接', () => {
  const tokens = parseMarkdown('[文字](https://x) ![alt](https://img) [[笔记标题]]')
  assert.ok(tokens.some((t) => t.kind === 'link' && t.url === 'https://x'))
  assert.ok(tokens.some((t) => t.kind === 'image' && t.url === 'https://img'))
  assert.ok(tokens.some((t) => t.kind === 'wikilink'))
})

test('块级与行内公式各生成一个 math token', () => {
  const tokens = parseMarkdown('$$\\sqrt{x}$$\n包含 $a^2$ 与 \\(\\sigma\\)')
  const math = tokens.filter((t) => t.kind === 'math')
  assert.equal(math.length, 3)
  const display = math.filter((t) => t.kind === 'math' && t.display)
  const inline = math.filter((t) => t.kind === 'math' && !t.display)
  assert.equal(display.length, 1)
  assert.equal(inline.length, 2)
})

test('同一行的块级公式不会被行内公式重复解析', () => {
  const tokens = parseMarkdown('说明 $$\\sqrt{x}$$ 结论')
  const math = tokens.filter((t) => t.kind === 'math')
  assert.equal(math.length, 1)
  assert.equal(math[0]?.display, true)
})

test('代码块内的 LaTeX 不被渲染成公式', () => {
  const tokens = parseMarkdown('```python\nsum = $x_1$ + $x_2$\n```')
  assert.ok(tokens.some((t) => t.kind === 'fence'))
  assert.ok(!tokens.some((t) => t.kind === 'math'))
})

test('未闭合 fenced code：公式仍受代码区间保护', () => {
  const source = '```\n$x$'
  const ranges = codeRanges(source)
  assert.deepEqual(ranges, [[0, source.length]])
})

test('不完整公式不会导致解析崩溃', () => {
  assert.doesNotThrow(() => parseMarkdown('$未闭合'))
  assert.doesNotThrow(() => parseMarkdown('$$未闭合'))
  assert.doesNotThrow(() => parseMarkdown('\\[未闭合'))
  assert.doesNotThrow(() => parseMarkdown('\\frac{a}{b} 普通文本'))
})

test('长公式：根号、上下标与转义下划线', () => {
  const tokens = parseMarkdown('$$\n\\sigma_p = \\sqrt{w_1^2 \\sigma_1^2}\n$$')
  const m = tokens.find((t) => t.kind === 'math' && t.display)
  assert.ok(m)
  if (m?.kind === 'math') {
    assert.match(m.expression, /\\sigma_p/)
    assert.match(m.expression, /\\sqrt/)
    assert.match(m.expression, /w_1\^2/)
  }
})
