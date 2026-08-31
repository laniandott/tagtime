import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { join, resolve, dirname, extname, basename, sep } from 'node:path'
import { readFile, writeFile, rename, unlink, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import prisma from './db.js'
import { NOTES_DIR } from './config.js'
import { parseLinks, normalizeTitleKey, isEntityLinkKey } from './links.js'
import { rebuildEntityLinksForNote } from './notes-entities.js'

// 笔记相关事件，阶段三由 WebSocket 订阅并广播
export const notesEmitter = new EventEmitter()

// ---- 哈希 ----
export function computeHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

// ---- 路径安全 ----
const FILE_NAME_ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g

// 由标题生成安全文件名（不含扩展名）
export function titleToFilename(title: string): string {
  const stem = title
    .trim()
    .replace(FILE_NAME_ILLEGAL, '_')
    .replace(/\.+$/g, '')
    .slice(0, 80)
  return stem || 'untitled'
}

// 校验并归一化一个相对 notes/ 的路径；不合法则抛错
export function normalizeNotePath(input: string): string {
  if (typeof input !== 'string' || !input) throw new Error('笔记路径不能为空')
  let p = input.replace(/\\/g, '/').trim()
  if (p.startsWith('/')) throw new Error('不允许绝对路径')
  if (/^[a-zA-Z]:/.test(p)) throw new Error('不允许绝对路径')
  if (p.split('/').includes('..')) throw new Error('不允许路径穿越(..)')
  const resolved = resolve(NOTES_DIR, p)
  if (!resolved.startsWith(resolve(NOTES_DIR) + sep)) throw new Error('路径越界')
  const firstSeg = p.split('/')[0]
  if (extname(p) !== '.md') throw new Error('笔记必须是 .md 文件')
  if (firstSeg === 'assets') throw new Error('assets 目录不允许作为笔记路径')
  return p
}

// ---- 原子写 ----
export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp`
  await writeFile(tmp, content, 'utf8')
  try {
    await rename(tmp, filePath)
  } catch (err: any) {
    // Windows 上 rename 无法直接覆盖已存在文件
    if (err.code === 'EEXIST' || err.code === 'EPERM' || err.code === 'ENOTEMPTY') {
      await unlink(filePath).catch(() => {})
      await rename(tmp, filePath)
    } else {
      throw err
    }
  }
}

// 读取笔记正文，path 必须是已校验的相对路径
export async function readNoteFile(relPath: string): Promise<string> {
  return readFile(join(NOTES_DIR, relPath), 'utf8')
}

// 标题默认取文件名（不含扩展名）；frontmatter 标题解析在后续版本支持
function titleFromPath(relPath: string): string {
  return basename(relPath ?? '', extname(relPath ?? ''))
}

// 同一笔记的写入按顺序执行，避免并发竞态
const writeQueues: Record<string, Promise<unknown>> = {}

function enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeQueues[key] ?? Promise.resolve()
  const next = prev.then(fn, fn)
  writeQueues[key] = next.catch(() => {})
  return next
}

// 同步单个笔记文件：读文件->算hash->更新Note->重建NoteLink->按需广播
// reason: 'api' | 'watcher' | 'startup' | 'rebuild'
export async function syncNoteFile(relPath: string, reason: string): Promise<{ id: string; changed: boolean } | null> {
  return enqueue(relPath, async () => {
    const abs = join(NOTES_DIR, relPath)
    let content: string
    try {
      content = await readFile(abs, 'utf8')
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        // 文件已不存在：交给删除路径处理，不在这里删索引
        return null
      }
      console.error(`[notes] 读取文件失败 ${relPath}: ${err.message}`)
      return null
    }

    const hash = computeHash(content)
    const title = titleFromPath(relPath)
    const titleKey = normalizeTitleKey(title)

    const existing = await prisma.note.findUnique({ where: { path: relPath } })
    // 内容与标题未变 → 不递增 revision，避免 watcher 重复触发
    if (existing && existing.contentHash === hash && existing.titleKey === titleKey) {
      await rebuildLinksForNote(existing.id)
      await rebuildEntityLinksForNote(existing.id)
      return { id: existing.id, changed: false }
    }

    let note = existing
    if (note) {
      note = await prisma.note.update({
        where: { id: note.id },
        data: { contentHash: hash, title, titleKey, revision: { increment: 1 } },
      })
    } else {
      note = await prisma.note.create({
        data: {
          path: relPath,
          title,
          titleKey,
          contentHash: hash,
        },
      })
    }

    // 新建/改名后，把其它笔记中此前指向该 titleKey 的未解析链接解析到本笔记
    await prisma.noteLink.updateMany({
      where: { isResolved: false, targetKey: titleKey },
      data: { isResolved: true, targetNoteId: note.id },
    })

    await rebuildLinksForNote(note.id)
    await rebuildEntityLinksForNote(note.id)

    notesEmitter.emit(existing ? 'note.updated' : 'note.created', {
      id: note.id,
      path: relPath,
      revision: note.revision,
    })
    return { id: note.id, changed: true }
  })
}

// 重建某笔记的出链 NoteLink（先删后插，按 targetKey 去重）
async function rebuildLinksForNote(noteId: string): Promise<void> {
  const note = await prisma.note.findUnique({ where: { id: noteId } })
  if (!note) return
  const content = await readFile(join(NOTES_DIR, note.path), 'utf8').catch(() => '')
  const links = parseLinks(content)
  await prisma.noteLink.deleteMany({ where: { sourceNoteId: noteId } })

  const seen = new Set<string>()
  const all = await prisma.note.findMany({ select: { titleKey: true, id: true } })
  const keyToId = new Map(all.map((n) => [n.titleKey, n.id]))

  for (const l of links) {
    if (seen.has(l.targetKey)) continue
    // 特殊前缀([[tag:/todo:/date:/memo:]])不进入普通笔记链接，由 NoteEntityLink 处理
    if (isEntityLinkKey(l.targetKey)) continue
    seen.add(l.targetKey)
    const targetId = keyToId.get(l.targetKey) ?? null
    await prisma.noteLink.create({
      data: {
        sourceNoteId: noteId,
        targetNoteId: targetId,
        targetTitle: l.targetTitle,
        targetKey: l.targetKey,
        linkText: l.linkText,
        isResolved: targetId != null,
      },
    })
  }
}

// 删除某相对路径的笔记：先置入链未解析，再删除（级联清出链），并广播
export async function removeNoteByPath(relPath: string): Promise<'deleted' | 'missing'> {
  return enqueue(relPath, async () => {
    const note = await prisma.note.findUnique({ where: { path: relPath } })
    if (!note) return 'missing' as const
    await prisma.noteLink.updateMany({
      where: { targetNoteId: note.id },
      data: { isResolved: false, targetNoteId: null },
    })
    await prisma.note.delete({ where: { id: note.id } })
    notesEmitter.emit('note.deleted', { id: note.id, path: relPath })
    return 'deleted' as const
  })
}

// 深扫 NOTES_DIR 下的全部 .md（跳过 .tmp/.bak 与 assets/）
async function collectMarkdownFiles(dir = NOTES_DIR): Promise<string[]> {
  const out: string[] = []
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (e.name === 'assets') continue
    if (e.name.endsWith('.tmp') || e.name.endsWith('.bak')) continue
    const rel = e.name
    if (e.isDirectory()) {
      // 第一版仅处理根目录单层，避让子目录递归的复杂度
      continue
    }
    if (e.isFile() && e.name.endsWith('.md')) {
      out.push(rel)
    }
  }
  return out
}

// 清理启动时残留的临时文件
async function cleanupTmpFiles(): Promise<void> {
  const files = await readdir(NOTES_DIR).catch(() => [])
  for (const f of files) {
    if (f.endsWith('.tmp')) {
      await unlink(join(NOTES_DIR, f)).catch(() => {})
    }
  }
}

// 启动全量重建：补建/更新索引、清理失效索引、清理残留 tmp
export async function reconcileNotesOnStartup(): Promise<void> {
  await cleanupTmpFiles()
  const files = await collectMarkdownFiles()
  const fileSet = new Set(files)
  for (const f of files) {
    await syncNoteFile(f, 'startup')
  }
  const dbNotes = await prisma.note.findMany({ select: { id: true, path: true } })
  for (const n of dbNotes) {
    if (!fileSet.has(n.path)) {
      await prisma.note.delete({ where: { id: n.id } }).catch(() => {})
    }
  }
}

// 可重复执行的全量重建，用于备份恢复与排障
export async function rebuildNotesIndex(): Promise<void> {
  await prisma.noteEntityLink.deleteMany({})
  await prisma.noteLink.deleteMany({})
  await prisma.note.deleteMany({})
  await reconcileNotesOnStartup()
}