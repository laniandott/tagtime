import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { join, resolve, dirname, extname, basename, sep, relative, posix } from 'node:path'
import { readFile, writeFile, rename, realpath, unlink, readdir, mkdir, rmdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import prisma from './db.js'
import { BODY_SIZE_LIMIT, CONTENT_LIMITS, NOTES_DIR } from './config.js'
import { parseLinks, normalizeTitleKey, isEntityLinkKey } from './links.js'
import { rebuildEntityLinksForNote } from './notes-entities.js'

// 供测试复用：笔记目录解析结果
export { NOTES_DIR }

// 笔记相关事件，阶段三由 WebSocket 订阅并广播
export const notesEmitter = new EventEmitter()

// ---- 哈希 ----
export function computeHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

// ---- 路径安全 ----
const FILE_NAME_ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g
const FILE_SEGMENT_ILLEGAL = /[<>:"\\|?*\u0000-\u001f]/
const RESERVED_ROOT_DIRS = new Set(['assets'])
const WINDOWS_RESERVED_BASENAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const MAX_NOTE_PATH_LENGTH = 1024
const MAX_NOTE_PATH_SEGMENTS = 32
const MAX_NOTE_PATH_SEGMENT_LENGTH = 255
const MAX_NOTE_FILE_BYTES = BODY_SIZE_LIMIT

function isWindowsReservedBasename(value: string): boolean {
  // Windows 设备名即使带扩展名也不能作为文件名（例如 CON.txt）。
  // 只检查第一个点之前的部分，并兼容末尾的点/空格已被清理的场景。
  return WINDOWS_RESERVED_BASENAMES.test(value.split('.')[0] ?? '')
}

function assertRelativeSegments(input: string, kind: '笔记' | '文件夹'): string[] {
  if (typeof input !== 'string') throw new Error(`${kind}路径不能为空`)
  const normalized = input.replace(/\\/g, '/').trim().replace(/\/+$/g, '')
  if (!normalized) return []
  if (normalized.length > MAX_NOTE_PATH_LENGTH) throw new Error('路径过长')
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) throw new Error('不允许绝对路径')
  const segments = normalized.split('/')
  if (segments.some((part) => !part || part === '.' || part === '..')) throw new Error('不允许空目录或路径穿越')
  if (segments.length > MAX_NOTE_PATH_SEGMENTS || segments.some((part) => part.length > MAX_NOTE_PATH_SEGMENT_LENGTH)) {
    throw new Error('路径层级或单段名称过长')
  }
  if (segments.some((part) => FILE_SEGMENT_ILLEGAL.test(part))) throw new Error('路径包含非法字符')
  if (segments.some((part) => part.endsWith('.') || part.endsWith(' '))) throw new Error('路径段不能以点或空格结尾')
  if (segments.some((part) => WINDOWS_RESERVED_BASENAMES.test(part.replace(/\..*$/, '')))) {
    throw new Error('路径包含 Windows 保留名称')
  }
  if (RESERVED_ROOT_DIRS.has(segments[0].toLowerCase())) throw new Error('assets 目录不允许作为笔记路径')
  return segments
}

// 由标题生成安全文件名（不含扩展名）
export function titleToFilename(title: string): string {
  let stem = title
    .trim()
    .replace(FILE_NAME_ILLEGAL, '_')
    .replace(/[ .]+$/g, '')
    .slice(0, 80)
  if (!stem) return 'untitled'
  if (isWindowsReservedBasename(stem)) stem = `_${stem}`
  return stem
}

// 校验并归一化一个相对 notes/ 的路径；不合法则抛错
export function normalizeNotePath(input: string): string {
  const segments = assertRelativeSegments(input, '笔记')
  if (!segments.length) throw new Error('笔记路径不能为空')
  const p = segments.join('/')
  const resolved = resolve(NOTES_DIR, p)
  if (!resolved.startsWith(resolve(NOTES_DIR) + sep)) throw new Error('路径越界')
  if (extname(p) !== '.md') throw new Error('笔记必须是 .md 文件')
  return p
}

// 文件夹路径相对 notes/；空字符串代表根目录。
export function normalizeNoteFolder(input = ''): string {
  const segments = assertRelativeSegments(input, '文件夹')
  const folder = segments.join('/')
  if (folder && !resolve(NOTES_DIR, folder).startsWith(resolve(NOTES_DIR) + sep)) throw new Error('路径越界')
  return folder
}

// 归一化相对路径并拼出绝对路径（所有文件读写入口都走这里）
export function noteAbsPath(relPath: string): string {
  return join(NOTES_DIR, normalizeNotePath(relPath))
}

function folderAbsPath(folder: string): string {
  const rel = normalizeNoteFolder(folder)
  return rel ? join(NOTES_DIR, rel) : NOTES_DIR
}

async function assertDirectoryWithin(abs: string): Promise<void> {
  const realRoot = await realpath(NOTES_DIR)
  const realDir = await realpath(abs)
  if (realDir !== realRoot && !realDir.startsWith(realRoot + sep)) throw new Error('符号链接越界')
}

export async function ensureNoteFolder(folder = ''): Promise<string> {
  const rel = normalizeNoteFolder(folder)
  let current = NOTES_DIR
  for (const segment of rel ? rel.split('/') : []) {
    current = join(current, segment)
    // recursive=true 让并发请求创建同一层目录时幂等，避免 existsSync→mkdir 的竞态产生 EEXIST。
    if (!existsSync(current)) await mkdir(current, { recursive: true })
    const info = await stat(current)
    if (!info.isDirectory()) throw new Error('文件夹路径已被文件占用')
    await assertDirectoryWithin(current)
  }
  return rel
}

export async function listNoteFolders(): Promise<string[]> {
  const folders: string[] = []
  async function walk(absDir: string, prefix: string): Promise<void> {
    const entries = await readdir(absDir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      try {
        normalizeNoteFolder(rel)
      } catch {
        continue
      }
      folders.push(rel)
      await walk(join(absDir, entry.name), rel)
    }
  }
  await walk(NOTES_DIR, '')
  return folders.sort((a, b) => a.localeCompare(b, 'zh-CN'))
}

export async function removeEmptyNoteFolder(folder: string): Promise<void> {
  const rel = normalizeNoteFolder(folder)
  if (!rel) throw new Error('不能删除笔记根目录')
  const abs = folderAbsPath(rel)
  await assertDirectoryWithin(abs)
  const entries = await readdir(abs)
  if (entries.length) throw new Error('文件夹不为空，请先移动或删除其中的笔记')
  await rmdir(abs)
}

// 符号链接越界检查：文件真实路径必须落在 notes/ 根内
async function assertRealWithin(abs: string): Promise<void> {
  let realFile: string
  try {
    realFile = await realpath(abs)
  } catch {
    return // 文件尚不存在（新建），仅做字符串级校验即可
  }
  const realRoot = await realpath(NOTES_DIR)
  if (!realFile.startsWith(realRoot + sep)) throw new Error('符号链接越界')
}

// ---- 原子写 ──
// Windows 上 rename 无法直接覆盖已存在文件。方案：先把旧文件移到 .bak，
// 再把 tmp 替换为正式文件。任一步失败都从 .bak 尽力恢复，避免“旧文件已删、新文件未成”的中断丢正文。
export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const relPath = relative(NOTES_DIR, resolve(filePath)).replace(/\\/g, '/')
  const safePath = normalizeNotePath(relPath)
  const parent = posix.dirname(safePath)
  await ensureNoteFolder(parent === '.' ? '' : parent)
  const tmp = `${filePath}.tmp`
  const bak = `${filePath}.bak`
  await writeFile(tmp, content, 'utf8')
  try {
    await rename(tmp, filePath)
  } catch (err: any) {
    if (err.code !== 'EEXIST' && err.code !== 'EPERM' && err.code !== 'ENOTEMPTY') throw err
    // 目标已存在，需先备份。若旧文件不存在（首次写入场景的防御分支），直接替换
    if (!existsSync(filePath)) {
      await rename(tmp, filePath)
      return
    }
    try {
      await rename(filePath, bak)
    } catch {
      // 旧文件无法备份：坚决不删除旧正文，保留原文件并上抛，避免写中断丢数据
      await unlink(tmp).catch(() => {})
      throw new Error('原子写失败：无法备份旧文件，原正文已保留')
    }
    try {
      await rename(tmp, filePath)
    } catch (e3) {
      // 新文件替换失败：从 .bak 恢复旧正文，避免丢失
      await rename(bak, filePath).catch(() => {})
      throw e3
    }
    await unlink(bak).catch(() => {})
  }
}

// 读取笔记正文，path 必须是已校验的相对路径
export async function readNoteFile(relPath: string): Promise<string> {
  const abs = noteAbsPath(relPath)
  await assertRealWithin(abs)
  const info = await stat(abs)
  if (!info.isFile() || info.size > MAX_NOTE_FILE_BYTES) throw new Error('笔记文件超过读取大小限制')
  const content = await readFile(abs, 'utf8')
  if (content.length > CONTENT_LIMITS.NOTE_CONTENT) throw new Error('笔记内容超过读取大小限制')
  return content
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
  const tail = next.catch(() => {})
  writeQueues[key] = tail
  void tail.then(() => {
    if (writeQueues[key] === tail) delete writeQueues[key]
  })
  return next
}

// 对某相对路径持有串行锁执行 fn；API 的“读 revision→校验→写文件→同步索引”整体放进来，杜绝并发静默覆盖
export function withNoteLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return enqueue(key, fn)
}

// ---- watcher / API 重命名协调 ----
// API 重命名会“写新路径文件、删旧路径文件”，这些文件系统操作会产生 Chokidar 事件。
// 若不抑制：watcher 可能在数据库把 Note.path 更新到新路径之前，先为新路径建一条新 Note
// （随后 API 更新触发 path 唯一约束冲突），也可能在 API 更新前删掉旧路径对应索引。
// 这里在 API 操作期间把相关路径标记为“暂停”，watcher 收到事件后直接跳过对应处理。
const suspendedWatcherPaths = new Map<string, number>()
export function suspendWatcherPaths(paths: Iterable<string>, ms: number): void {
  const arr = Array.from(paths)
  for (const p of arr) suspendedWatcherPaths.set(p, (suspendedWatcherPaths.get(p) ?? 0) + 1)
  setTimeout(() => {
    for (const p of arr) {
      const remaining = (suspendedWatcherPaths.get(p) ?? 1) - 1
      if (remaining > 0) suspendedWatcherPaths.set(p, remaining)
      else suspendedWatcherPaths.delete(p)
    }
  }, ms)
}
export function isWatcherPathSuspended(relPath: string): boolean {
  return suspendedWatcherPaths.has(relPath)
}

// 同步单个笔记文件：读文件->算hash->更新Note->重建NoteLink->按需广播
// reason: 'api' | 'watcher' | 'startup' | 'rebuild'
// 注：本函数不做加锁，调用方须通过 syncNoteFile（自加 per-path 锁）或已在 withNoteLock 内
export async function syncNoteFileLocked(
  relPath: string,
  reason: string,
): Promise<{ id: string; changed: boolean } | null> {
  let rel: string
  try {
    rel = normalizeNotePath(relPath)
  } catch (e: any) {
    console.error(`[notes] 非法笔记路径被跳过 ${relPath}: ${e.message}`)
    return null
  }
  const abs = noteAbsPath(rel)
  let content: string
  try {
    await assertRealWithin(abs)
    const info = await stat(abs)
    if (!info.isFile() || info.size > MAX_NOTE_FILE_BYTES) {
      console.error(`[notes] 文件超过读取大小限制，跳过索引 ${rel}`)
      return null
    }
    content = await readFile(abs, 'utf8')
    if (content.length > CONTENT_LIMITS.NOTE_CONTENT) {
      console.error(`[notes] 文件超过内容字符限制，跳过索引 ${rel}`)
      return null
    }
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      // 文件已不存在：交给删除路径处理，不在这里删索引
      return null
    }
    console.error(`[notes] 读取文件失败 ${rel}: ${err.message}`)
    return null
  }

  const hash = computeHash(content)
  const title = titleFromPath(rel)
  const titleKey = normalizeTitleKey(title)

  let existing = await prisma.note.findUnique({ where: { path: rel } })
  let relocatedFrom: string | null = null
  if (!existing) {
    const sameTitle = await prisma.note.findUnique({ where: { titleKey } })
    if (sameTitle) {
      // 服务停止期间在磁盘上移动文件/文件夹：旧路径已消失时迁移原索引，保留 Note ID。
      // 若旧文件仍存在，则是两个同标题文件；保持全局标题唯一，跳过新文件而不让启动扫描崩溃。
      if (existsSync(noteAbsPath(sameTitle.path))) {
        console.error(`[notes] 同标题笔记被跳过 ${rel}: 已存在 ${sameTitle.path}`)
        return null
      }
      relocatedFrom = sameTitle.path
      existing = await prisma.note.update({
        where: { id: sameTitle.id },
        data: { path: rel, title, titleKey, contentHash: hash, revision: { increment: 1 } },
      })
    }
  }
  // 内容与标题未变 → 不递增 revision，避免 watcher 重复触发
  if (existing && !relocatedFrom && existing.contentHash === hash && existing.titleKey === titleKey) {
    await rebuildLinksForNote(existing.id)
    await rebuildEntityLinksForNote(existing.id)
    return { id: existing.id, changed: false }
  }

  let note = existing
  if (!note) {
    note = await prisma.note.create({
      data: {
        path: rel,
        title,
        titleKey,
        contentHash: hash,
      },
    })
  } else if (!relocatedFrom) {
    note = await prisma.note.update({
      where: { id: note.id },
      data: { contentHash: hash, title, titleKey, revision: { increment: 1 } },
    })
  }

  // 新建/改名后，把其它笔记中此前指向该 titleKey 的未解析链接解析到本笔记
  await prisma.noteLink.updateMany({
    where: { isResolved: false, targetKey: titleKey },
    data: { isResolved: true, targetNoteId: note.id },
  })

  await rebuildLinksForNote(note.id)
  await rebuildEntityLinksForNote(note.id)

  if (relocatedFrom) {
    notesEmitter.emit('note.renamed', { id: note.id, path: rel, from: relocatedFrom, revision: note.revision })
  } else {
    notesEmitter.emit(existing ? 'note.updated' : 'note.created', {
      id: note.id,
      path: rel,
      revision: note.revision,
    })
  }
  return { id: note.id, changed: true }
}

// 带 per-path 串行锁的同步入口（watcher、启动扫描使用）
export async function syncNoteFile(
  relPath: string,
  reason: string,
): Promise<{ id: string; changed: boolean } | null> {
  return enqueue(relPath, () => syncNoteFileLocked(relPath, reason))
}

// 重建某笔记的出链 NoteLink（先删后插，按 targetKey 去重）
async function rebuildLinksForNote(noteId: string): Promise<void> {
  const note = await prisma.note.findUnique({ where: { id: noteId } })
  if (!note) return
  const content = await readFile(noteAbsPath(note.path), 'utf8').catch(() => '')
  const links = parseLinks(content)
  await prisma.noteLink.deleteMany({ where: { sourceNoteId: noteId } })

  const seen = new Set<string>()
  const targetKeys = [...new Set(
    links.filter((l) => !isEntityLinkKey(l.targetKey)).map((l) => l.targetKey),
  )]
  const targets: { titleKey: string; id: string }[] = []
  // SQLite 对单条语句的绑定参数数量有限；大笔记可能包含上千个链接，
  // 分批查询避免保存时因 SQLITE_MAX_VARIABLE_NUMBER 触发 500。
  for (let i = 0; i < targetKeys.length; i += 500) {
    targets.push(...await prisma.note.findMany({
      where: { titleKey: { in: targetKeys.slice(i, i + 500) } },
      select: { titleKey: true, id: true },
    }))
  }
  const keyToId = new Map(targets.map((n) => [n.titleKey, n.id]))

  const data: {
    sourceNoteId: string
    targetNoteId: string | null
    targetTitle: string
    targetKey: string
    linkText: string
    isResolved: boolean
  }[] = []
  for (const l of links) {
    if (seen.has(l.targetKey)) continue
    // 特殊前缀([[tag:/todo:/date:/memo:]])不进入普通笔记链接，由 NoteEntityLink 处理
    if (isEntityLinkKey(l.targetKey)) continue
    seen.add(l.targetKey)
    const targetId = keyToId.get(l.targetKey) ?? null
    data.push({
      sourceNoteId: noteId,
      targetNoteId: targetId,
      targetTitle: l.targetTitle,
      targetKey: l.targetKey,
      linkText: l.linkText,
      isResolved: targetId != null,
    })
  }
  for (let i = 0; i < data.length; i += 100) {
    await prisma.noteLink.createMany({ data: data.slice(i, i + 100) })
  }
}

// 删除某相对路径的笔记的索引（不删文件）：先置入链未解析，再删除（级联清出链），并广播
// 调用方须持有该路径的锁（withNoteLock）或经 removeNoteByPath 带锁调用；文件不存在时幂等返回 missing
export async function removeNoteLocked(relPath: string): Promise<'deleted' | 'missing'> {
  const note = await prisma.note.findUnique({ where: { path: relPath } })
  if (!note) return 'missing' as const
  await prisma.noteLink.updateMany({
    where: { targetNoteId: note.id },
    data: { isResolved: false, targetNoteId: null },
  })
  await prisma.note.delete({ where: { id: note.id } })
  notesEmitter.emit('note.deleted', { id: note.id, path: relPath })
  return 'deleted' as const
}

// watcher 入口：带 per-path 锁删除索引；即便与 API DELETE 竞态，也因同一把锁而幂等
export async function removeNoteByPath(relPath: string): Promise<'deleted' | 'missing'> {
  return enqueue(relPath, () => removeNoteLocked(relPath))
}

// 把正文中的 [[旧标题]] / [[旧标题|别名]] 改写为新标题（大小写不敏感，保留别名）。
// 跳过 fenced 代码块、行内代码与转义的 \[[ ，与 parseLinks 的语义保持一致。命中则返回改写后内容。
export function rewriteTitleLinks(content: string, oldTitle: string, newTitle: string): string {
  const oldKey = normalizeTitleKey(oldTitle)
  const masked: boolean[] = new Array(content.length).fill(false)
  const maskCode = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`/g
  let cm: RegExpExecArray | null
  while ((cm = maskCode.exec(content)) !== null) {
    for (let j = cm.index; j < cm.index + cm[0].length; j++) masked[j] = true
  }
  const re = /\[\[([^\[\]]+)\]\]/g
  const parts: string[] = []
  let last = 0
  let changed = false
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    if (masked[m.index]) continue
    // 与 Markdown 的转义语义保持一致：奇数个连续反斜杠表示首个 '[' 被转义，
    // 此时不能把后续内容当成可改写的 Wiki 链接。
    let slashCount = 0
    for (let j = m.index - 1; j >= 0 && content[j] === '\\'; j--) slashCount++
    if (slashCount % 2 === 1) continue
    const raw = m[1].trim()
    const i = raw.indexOf('|')
    const target = i === -1 ? raw : raw.slice(0, i).trim()
    if (normalizeTitleKey(target) === oldKey) {
      const alias = i === -1 ? '' : raw.slice(i)
      parts.push(content.slice(last, m.index), `[[${newTitle}${alias}]]`)
      last = m.index + m[0].length
      changed = true
    }
  }
  if (!changed) return content
  parts.push(content.slice(last))
  return parts.join('')
}

// 扫描根目录全部 .md，把其它笔记正文里的 [[旧标题]]/[[旧标题|别名]] 改写为新标题并重建出链索引。
// 每个文件的“读→改写→写→同步索引”整体放进该文件自身的锁（与普通 PUT/DELETE 互斥）。
// 调用方须持有全局重命名锁(__rename) 且已把被重命名笔记的 title/titleKey 更新为新值。
// skipPath：被重命名笔记自身（其标题就是被改的那篇，正文里的自引用不应按“别的笔记”改写）。
export async function rewriteNoteTitleInOthers(
  oldTitle: string,
  newTitle: string,
  skipPath?: string,
): Promise<number> {
  let count = 0
  const files = await collectMarkdownFiles()
  for (const f of files) {
    if (f === skipPath) continue
    const done = await withNoteLock(f, async () => {
      const abs = noteAbsPath(f)
      const content = await readFile(abs, 'utf8').catch(() => null)
      if (content === null) return false
      const next = rewriteTitleLinks(content, oldTitle, newTitle)
      if (next === content) return false
      await atomicWriteFile(abs, next)
      await syncNoteFileLocked(f, 'api') // 已持有 f 的锁，走不加锁的核心逻辑
      return true
    })
    if (done) count++
  }
  return count
}

// 深扫 NOTES_DIR 下的全部 .md（跳过 .tmp/.bak、assets/ 与符号链接目录）
async function collectMarkdownFiles(dir = NOTES_DIR, prefix = ''): Promise<string[]> {
  const out: string[] = []
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (!prefix && e.name.toLowerCase() === 'assets') continue
    if (e.name.endsWith('.tmp') || e.name.endsWith('.bak')) continue
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory() && !e.isSymbolicLink()) {
      out.push(...await collectMarkdownFiles(join(dir, e.name), rel))
    }
    if (e.isFile() && e.name.endsWith('.md')) {
      try {
        out.push(normalizeNotePath(rel))
      } catch {
        // 非法文件名留在磁盘，但不进入索引。
      }
    }
  }
  return out
}

// 启动时清理残留的临时文件，并恢复中断的原子写：
// .tmp 是没写完的产物，直接丢弃；.bak 是上一次替换时暂存的旧正文，
// 目标文件若还在就直接删 .bak，若已缺失则从 .bak 恢复，避免正文丢失。
export async function cleanupTmpFiles(): Promise<void> {
  async function walk(dir: string, isRoot: boolean): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (isRoot && entry.name.toLowerCase() === 'assets') continue
      const abs = join(dir, entry.name)
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await walk(abs, false)
      } else if (entry.isFile() && entry.name.endsWith('.tmp')) {
        await unlink(abs).catch(() => {})
      } else if (entry.isFile() && entry.name.endsWith('.bak')) {
        const target = abs.slice(0, -'.bak'.length)
        if (!existsSync(target)) await rename(abs, target).catch(() => {})
        else await unlink(abs).catch(() => {})
      }
    }
  }
  await walk(NOTES_DIR, true)
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
      // 复用 removeNoteLocked：删除前先把所有指向它的链接置为 isResolved=false，避免残留“已解析”指向不存在目标
      await removeNoteLocked(n.path)
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
