import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildNoteTree } from '../src/pages/NotesPage'
import type { NoteListEntry } from '../src/types'

const note = (path: string): NoteListEntry => ({
  id: path,
  path,
  title: path,
  revision: 1,
  createdAt: '2026-09-02T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
  outLinkCount: 0,
  inLinkCount: 0,
})

test('笔记树不会为单层文件夹创建错误的字符父级', () => {
  const tree = buildNoteTree(['中会', '中会/财管练习'], [note('中会/财管练习/第一章.md')])

  assert.deepEqual(tree.children.map((child) => child.path), ['中会'])
  assert.equal(tree.children.some((child) => child.path === '中'), false)
  assert.deepEqual(tree.children[0]?.children.map((child) => child.path), ['中会/财管练习'])
})
