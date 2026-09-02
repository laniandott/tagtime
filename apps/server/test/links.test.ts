import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseLinks,
  parseEntityLinks,
  isEntityLinkKey,
  normalizeTitleKey,
} from '../src/links.js'
import { rewriteTitleLinks } from '../src/notes.js'

test('normalizeTitleKey：trim/合并空白/小写', () => {
  assert.equal(normalizeTitleKey('  A   B  '), 'a b')
  assert.equal(normalizeTitleKey('Old'), 'old')
})

test('isEntityLinkKey：识别 tag/todo/date/memo 前缀，普通链接为 false', () => {
  assert.equal(isEntityLinkKey('tag:工作'), true)
  assert.equal(isEntityLinkKey('todo:x'), true)
  assert.equal(isEntityLinkKey('DATE:2026-08-31'), true)
  assert.equal(isEntityLinkKey('memo:abc'), true)
  assert.equal(isEntityLinkKey('普通标题'), false)
  assert.equal(isEntityLinkKey(''), false)
})

test('parseLinks：解析 [[标题]] 与 [[标题|别名]]，忽略代码与转义', () => {
  const out = parseLinks('见 [[foo]] 和 [[Foo Bar|别名]]，代码 `[[skipped]]` ```\n[[skip2]]\n``` \\[[esc]]')
  const keys = out.map((l) => l.targetKey)
  assert.deepEqual(keys, ['foo', 'foo bar'])
  const alias = out.find((l) => l.targetKey === 'foo bar')
  assert.equal(alias?.linkText, '别名')
})

test('parseEntityLinks：解析 tag/todo/date/memo 并保留别名', () => {
  const out = parseEntityLinks('[[tag:工作]] [[todo:买电脑|采购]] [[date:2026-08-31]] [[memo:abc123|今天的日记]]')
  assert.deepEqual(
    out.map((l) => [l.type, l.entityKey, l.linkText]),
    [
      ['tag', '工作', ''],
      ['todo', '买电脑', '采购'],
      ['date', '2026-08-31', ''],
      ['memo', 'abc123', '今天的日记'],
    ],
  )
  // 非特殊前缀不给实体
  assert.equal(parseEntityLinks('[[普通标题]]').length, 0)
})

test('rewriteTitleLinks：不改写转义的 Wiki 链接', () => {
  const source = String.raw`转义 \[[Old]]，正常 [[Old]]，双反斜杠 \\[[Old]]`
  const result = rewriteTitleLinks(source, 'Old', 'New')
  assert.equal(result, String.raw`转义 \[[Old]]，正常 [[New]]，双反斜杠 \\[[New]]`)
})
