import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeTitleKey } from '../src/links.js'

const serverRoot = dirname(dirname(fileURLToPath(import.meta.url))) // apps/server
const tmpRoot = mkdtempSync(join(tmpdir(), 'tt-int-'))
const notesDir = join(tmpRoot, 'notes')
process.env.DATA_DIR = join(tmpRoot, 'data')
process.env.NOTES_DIR = notesDir
process.env.DATABASE_URL = `file:${join(tmpRoot, 'int.db')}`

// 先往临时库 push 真实 schema（用 node 直接调 prisma CLI，避免 win 下 sh 脚本不可执行）
execSync('node node_modules/prisma/build/index.js db push --skip-generate --schema src/schema.prisma', {
  cwd: serverRoot,
  env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
  stdio: 'pipe',
})

let notes: typeof import('../src/notes.js')
let prisma: typeof import('../src/db.js').default
before(async () => {
  notes = await import('../src/notes.js')
  prisma = (await import('../src/db.js')).default
})
after(async () => {
  await prisma?.$disconnect()
  rmSync(tmpRoot, { recursive: true, force: true })
})

test('同步：同一内容二次 sync 走哈希去重，不递增 revision', async () => {
  writeFileSync(join(notesDir, 'dedup.md'), 'version 1')
  const first = await notes.syncNoteFile('dedup.md', 'test')
  assert.equal(first?.changed, true)
  const rev1 = (await prisma.note.findUnique({ where: { path: 'dedup.md' } }))!.revision
  const second = await notes.syncNoteFile('dedup.md', 'test')
  assert.equal(second?.changed, false)
  const rev2 = (await prisma.note.findUnique({ where: { path: 'dedup.md' } }))!.revision
  assert.equal(rev1, rev2)
})

test('删除：removeNoteByPath 二次调用幂等（watcher 与 API 竞态场景）', async () => {
  writeFileSync(join(notesDir, 'C.md'), 'c')
  await notes.syncNoteFile('C.md', 'test')
  assert.equal(await notes.removeNoteByPath('C.md'), 'deleted')
  assert.equal(await notes.removeNoteByPath('C.md'), 'missing')
  const gone = await prisma.note.findUnique({ where: { path: 'C.md' } })
  assert.equal(gone, null)
})

test('启动恢复：磁盘缺失的失效 Note 删除前，将其入链置 isResolved=false', async () => {
  writeFileSync(join(notesDir, 'A.md'), 'note A')
  writeFileSync(join(notesDir, 'B.md'), '关联 [[A]]')
  await notes.syncNoteFile('A.md', 'test')
  await notes.syncNoteFile('B.md', 'test')
  const a = await prisma.note.findUnique({ where: { path: 'A.md' } })
  const b = await prisma.note.findUnique({ where: { path: 'B.md' } })
  assert.ok(a && b)
  const linkBefore = await prisma.noteLink.findUnique({
    where: { sourceNoteId_targetKey: { sourceNoteId: b.id, targetKey: 'a' } },
  })
  assert.equal(linkBefore?.isResolved, true)
  assert.equal(linkBefore?.targetNoteId, a.id)

  // 模拟磁盘上 A 丢失后重启重建
  rmSync(join(notesDir, 'A.md'))
  await notes.reconcileNotesOnStartup()

  const aAfter = await prisma.note.findUnique({ where: { id: a.id } })
  assert.equal(aAfter, null, '失效 Note 应从索引移除')
  const linkAfter = await prisma.noteLink.findUnique({
    where: { sourceNoteId_targetKey: { sourceNoteId: b.id, targetKey: 'a' } },
  })
  assert.ok(linkAfter, '入链应保留')
  assert.equal(linkAfter.isResolved, false)
  assert.equal(linkAfter.targetNoteId, null)
})

test('重命名：改写其它正文 [[旧标题]] 链接并重建为解析到新标题', async () => {
  writeFileSync(join(notesDir, 'Old.md'), '# Old')
  writeFileSync(join(notesDir, 'Companion.md'), '见 [[Old]] 和 [[Old|别名]]')
  await notes.syncNoteFile('Old.md', 'test')
  await notes.syncNoteFile('Companion.md', 'test')

  const oldNote = await prisma.note.findUnique({ where: { path: 'Old.md' } })
  const companion = await prisma.note.findUnique({ where: { path: 'Companion.md' } })
  assert.ok(oldNote && companion)
  const linkBefore = await prisma.noteLink.findUnique({
    where: { sourceNoteId_targetKey: { sourceNoteId: companion.id, targetKey: 'old' } },
  })
  assert.equal(linkBefore?.isResolved, true)

  // 模拟应用内重命名：改文件 + 更新索引（保留 Note ID）
  const newTitle = '新名系列'
  renameSync(join(notesDir, 'Old.md'), join(notesDir, `${newTitle}.md`))
  await prisma.note.update({
    where: { id: oldNote.id },
    data: { path: `${newTitle}.md`, title: newTitle, titleKey: normalizeTitleKey(newTitle) },
  })

  const rewritten = await notes.rewriteNoteTitleInOthers('Old', newTitle)
  assert.ok(rewritten >= 1, '应改写至少一个文件')

  const content = readFileSync(join(notesDir, 'Companion.md'), 'utf8')
  assert.ok(content.includes(`[[${newTitle}]]`), '无别名旧链接被改写')
  assert.ok(content.includes(`[[${newTitle}|别名]]`), '带别名旧链接被改写')
  assert.ok(!content.includes('[[Old]]'), '旧标题不应再残留')

  const linkAfter = await prisma.noteLink.findUnique({
    where: { sourceNoteId_targetKey: { sourceNoteId: companion.id, targetKey: normalizeTitleKey(newTitle) } },
  })
  assert.equal(linkAfter?.isResolved, true)
  assert.equal(linkAfter?.targetNoteId, oldNote.id)
})