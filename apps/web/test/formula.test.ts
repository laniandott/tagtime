import { test } from 'node:test'
import assert from 'node:assert/strict'
import katex from 'katex'
import { normalizeMathExpression } from '../src/editor/markdownTokens'

test('块级公式 $$\\sqrt{x_1^2+x_2^2}$$ 正确生成 KaTeX', () => {
  const html = katex.renderToString(normalizeMathExpression('\\sqrt{x_1^2+x_2^2}'), {
    throwOnError: false,
    strict: 'ignore',
    trust: false,
  })
  assert.match(html, /sqrt/)
  assert.match(html, /x_1/)
  assert.match(html, /x_2/)
})

test('行内公式正确生成 KaTeX', () => {
  const html = katex.renderToString(normalizeMathExpression('\\sigma'), {
    throwOnError: false,
    strict: 'ignore',
    trust: false,
  })
  assert.match(html, /sigma/)
})

test('公式中的 \\_ 能被兼容（还原为下标）', () => {
  const expression = normalizeMathExpression('\\sigma_p = \\sqrt{w\\_1^2}')
  assert.equal(expression, '\\sigma_p = \\sqrt{w_1^2}')
  assert.doesNotThrow(() =>
    katex.renderToString(expression, { throwOnError: false, strict: 'ignore', trust: false }),
  )
})

test('分数 / 粗体 / 文本命令可渲染', () => {
  const html = katex.renderToString('\\frac{a}{b} \\mathbf{x} \\text{文本}', {
    throwOnError: false,
    strict: 'ignore',
    trust: false,
  })
  assert.match(html, /frac/)
  assert.match(html, /mathbf/)
})

test('不完整公式不会抛异常（回退渲染）', () => {
  assert.doesNotThrow(() =>
    katex.renderToString('\\frac{a}{', { throwOnError: false, strict: 'ignore', trust: false }),
  )
  assert.doesNotThrow(() =>
    katex.renderToString('\\sqrt{', { throwOnError: false, strict: 'ignore', trust: false }),
  )
})