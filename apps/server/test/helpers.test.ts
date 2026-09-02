import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
  chmodSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { isSafeUploadPath } from '../src/upload-path.js'

// 必须在动态导入 src 模块前设置环境，使其隔离到临时目录/临时数据库
const tmpRoot = mkdtempSync(join(tmpdir(), 'tt-helpers-'))
process.env.DATA_DIR = join(tmpRoot, 'data')
process.env.NOTES_DIR = join(tmpRoot, 'notes')
process.env.DATABASE_URL = `file:${join(tmpRoot, 'test.db').replace(/\\/g, '/')}`

let mod: typeof import('../src/notes.js')
before(async () => {
  mod = await import('../src/notes.js')
})
after(() => rmSync(tmpRoot, { recursive: true, force: true }))

test('normalizeNotePath：允许安全子目录，拒绝绝对路径/穿越/非法路径/assets', () => {
  for (const bad of ['/abs.md', 'C:/x.md', '../x.md', 'a/../x.md', 'a//x.md', 'x.txt', 'assets/a.md', 'a/<x>.md', '']) {
    assert.throws(() => mod.normalizeNotePath(bad))
  }
  assert.throws(() => mod.normalizeNotePath(`${'a/'.repeat(32)}x.md`), /层级|过长/)
  assert.throws(() => mod.normalizeNoteFolder('a'.repeat(256)), /层级|过长/)
  assert.equal(mod.normalizeNotePath('A B.md'), 'A B.md')
  assert.equal(mod.normalizeNotePath('x.md'), 'x.md')
  assert.equal(mod.normalizeNotePath('工作/项目/x.md'), '工作/项目/x.md')
  assert.equal(mod.normalizeNotePath('工作\\项目\\x.md'), '工作/项目/x.md')
  assert.equal(mod.normalizeNoteFolder('工作/项目'), '工作/项目')
  assert.equal(mod.normalizeNoteFolder(''), '')
  assert.throws(() => mod.normalizeNotePath('CON.md'), /保留名称/)
  assert.throws(() => mod.normalizeNoteFolder('LPT1'), /保留名称/)
})

test('noteAbsPath/atomicWriteFile：可在 notes 子目录安全读写', async () => {
  mkdirSync(mod.NOTES_DIR, { recursive: true })
  writeFileSync(join(mod.NOTES_DIR, 'x.md'), 'hi')
  const abs = mod.noteAbsPath('x.md')
  assert.equal(readFileSync(abs, 'utf8'), 'hi')
  const nested = mod.noteAbsPath('工作/项目/nested.md')
  await mod.atomicWriteFile(nested, '# nested')
  assert.equal(readFileSync(nested, 'utf8'), '# nested')
})

test('readNoteFile：拒绝超过内容上限的外部 Markdown 文件', async () => {
  const large = join(mod.NOTES_DIR, 'too-large.md')
  writeFileSync(large, 'x'.repeat(900_001))
  await assert.rejects(() => mod.readNoteFile('too-large.md'), /超过读取大小限制/)
})

test('ensureNoteFolder：路径被普通文件占用时拒绝创建子目录', async () => {
  const occupied = join(mod.NOTES_DIR, 'occupied')
  writeFileSync(occupied, 'not a directory')
  await assert.rejects(() => mod.ensureNoteFolder('occupied/child'), /文件夹路径已被文件占用/)
})

test('ensureNoteFolder：并发创建同一目录应幂等成功', async () => {
  const folder = `并发目录-${Date.now()}`
  await Promise.all([
    mod.ensureNoteFolder(`${folder}/子目录`),
    mod.ensureNoteFolder(`${folder}/子目录`),
  ])
})

test('titleToFilename：剔除非法字符/结尾点/截断/空标题兜底', () => {
  assert.equal(mod.titleToFilename('a<b>c'), 'a_b_c')
  assert.equal(mod.titleToFilename('abc.'), 'abc')
  assert.equal(mod.titleToFilename('   '), 'untitled')
  assert.equal(mod.titleToFilename('CON'), '_CON')
  assert.equal(mod.titleToFilename('CON.txt'), '_CON.txt')
  assert.equal(mod.titleToFilename('COM1.log'), '_COM1.log')
  assert.equal(mod.titleToFilename('abc '), 'abc')
})

test('rewriteTitleLinks：改写旧标题、保留别名、大小写不敏感', () => {
  const s = '见 [[Old]] 与 [[Old|另名]] 和 [[other]] 以及转义 \\[[Old]]'
  const out = mod.rewriteTitleLinks(s, 'old', '新名')
  assert.equal(out, '见 [[新名]] 与 [[新名|另名]] 和 [[other]] 以及转义 \\[[Old]]')
  // 大小写不敏感：Old 别名为中文
  assert.equal(mod.rewriteTitleLinks('[[OLD]]', 'old', 'New'), '[[New]]')
})

test('rewriteTitleLinks：跳过 fenced 代码块与单反引号行内代码', () => {
  const s = '```\n[[Old]]\n```\n然后 `[[Old]]` 和转义 \\[[Old]]\n正文 [[Old]]'
  const out = mod.rewriteTitleLinks(s, 'old', 'New')
  assert.ok(out.includes('```\n[[Old]]\n```'), 'fenced 代码块内不改写')
  assert.ok(out.includes('`[[Old]]`'), '行内代码不改写')
  assert.ok(out.includes('\\[[Old]]'), '转义不改写')
  assert.ok(out.endsWith('正文 [[New]]'), '正文改写')
})

test('atomicWriteFile：覆盖已存在文件（Windows EPERM 路径）', async () => {
  mkdirSync(mod.NOTES_DIR, { recursive: true })
  const p = join(mod.NOTES_DIR, 'over.md')
  writeFileSync(p, 'old')
  await mod.atomicWriteFile(p, 'new')
  assert.equal(readFileSync(p, 'utf8'), 'new')
  assert.ok(!existsSync(p + '.bak'))
  assert.ok(!existsSync(p + '.tmp'))
})

test('atomicWriteFile：首次写入创建文件', async () => {
  const p = join(mod.NOTES_DIR, 'first.md')
  await mod.atomicWriteFile(p, 'fresh')
  assert.equal(readFileSync(p, 'utf8'), 'fresh')
})

test('atomicWriteFile：替换失败且无法备份时，保留旧正文并抛错、不强删旧文件', async () => {
  // 强制 rename(tmp→filePath) EPERM：把目标改成只读；强制 rename(filePath→bak) 失败：把 bak 占成目录
  const p = join(mod.NOTES_DIR, 'guard.md')
  writeFileSync(p, 'precious')
  chmodSync(p, 0o444)
  await import('node:fs/promises').then(({ mkdir: mkdirP }) => mkdirP(p + '.bak', { recursive: true }))
  await assert.rejects(() => mod.atomicWriteFile(p, 'lost'), /原子写失败/)
  // 旧正文必须完整保留
  assert.equal(readFileSync(p, 'utf8'), 'precious')
  chmodSync(p, 0o644)
})

test('cleanupTmpFiles：目标缺失时从 .bak 恢复正文', async () => {
  // 通过重建模块不现实，改直接调用 cleanup（同样依赖 NOTES_DIR）
  const bak = join(mod.NOTES_DIR, 'recover.md.bak')
  const target = join(mod.NOTES_DIR, 'recover.md')
  writeFileSync(bak, 'recovered')
  rmSync(target, { force: true })
  await mod.cleanupTmpFiles()
  assert.equal(readFileSync(target, 'utf8'), 'recovered')
  assert.ok(!existsSync(bak))
})

test('cleanupTmpFiles：目标存在时丢弃多余 .bak', async () => {
  const target = join(mod.NOTES_DIR, 'keep.md')
  writeFileSync(target, 'current')
  writeFileSync(target + '.bak', 'stale')
  writeFileSync(join(mod.NOTES_DIR, 'junk.tmp'), 'x')
  await mod.cleanupTmpFiles()
  assert.equal(readFileSync(target, 'utf8'), 'current')
  assert.ok(!existsSync(target + '.bak'))
  assert.ok(!existsSync(join(mod.NOTES_DIR, 'junk.tmp')))
})

test('cleanupTmpFiles：递归恢复子目录中的 .bak 并清理 .tmp', async () => {
  const nested = join(mod.NOTES_DIR, '归档', '项目')
  mkdirSync(nested, { recursive: true })
  writeFileSync(join(nested, 'recover.md.bak'), 'nested recovered')
  writeFileSync(join(nested, 'junk.tmp'), 'x')
  await mod.cleanupTmpFiles()
  assert.equal(readFileSync(join(nested, 'recover.md'), 'utf8'), 'nested recovered')
  assert.ok(!existsSync(join(nested, 'recover.md.bak')))
  assert.ok(!existsSync(join(nested, 'junk.tmp')))
})

test('withNoteLock：同一 key 串行执行，互不交错', async () => {
  const order: number[] = []
  const jobs = [1, 2, 3, 4, 5].map((n) =>
    mod.withNoteLock('k', async () => {
      order.push(n)
      await new Promise((r) => setTimeout(r, 5))
      order.push(n)
    }),
  )
  await Promise.all(jobs)
  for (const n of [1, 2, 3, 4, 5]) assert.equal(order.filter((x) => x === n).length, 2)
  // 成对出现，即绝不并发交错
  assert.ok(order[0] === order[1] && order[2] === order[3] && order[4] === order[5])
})

test('静态 uploads：拒绝最终文件和中间目录的符号链接', async () => {
  const uploadRoot = join(tmpRoot, 'uploads-static')
  const outside = join(tmpRoot, 'outside-secret.txt')
  mkdirSync(uploadRoot, { recursive: true })
  writeFileSync(join(uploadRoot, 'inside.txt'), 'inside')
  writeFileSync(outside, 'secret')
  const fileLink = join(uploadRoot, 'file-link.txt')
  const dirLink = join(uploadRoot, 'dir-link')
  mkdirSync(join(tmpRoot, 'outside-dir'), { recursive: true })
  writeFileSync(join(tmpRoot, 'outside-dir', 'secret.txt'), 'secret')
  try {
    symlinkSync(outside, fileLink)
    symlinkSync(join(tmpRoot, 'outside-dir'), dirLink, 'junction')
  } catch {
    // Windows 未授予创建符号链接权限时跳过该平台专属回归测试。
    return
  }

  const app = Fastify({ logger: false })
  await app.register(fastifyStatic, {
    root: uploadRoot,
    prefix: '/uploads/',
    allowedPath: isSafeUploadPath,
    decorateReply: false,
  })
  await app.ready()
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/uploads/inside.txt' })).statusCode, 200)
    assert.equal((await app.inject({ method: 'GET', url: '/uploads/file-link.txt' })).statusCode, 404)
    assert.equal((await app.inject({ method: 'GET', url: '/uploads/dir-link/secret.txt' })).statusCode, 404)
  } finally {
    await app.close()
    rmSync(fileLink, { force: true })
    rmSync(dirLink, { recursive: true, force: true })
  }
})
