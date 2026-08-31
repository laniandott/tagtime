#!/usr/bin/env node
// TagTime 离线备份 / 恢复 CLI
//
// 用途：在服务端进程停止的前提下，将全部持久化用户数据（SQLite 主库及 -wal/-shm、
//       NOTES_DIR 下 Markdown、DATA_DIR/uploads 下附件）备份到指定目录，或从备份恢复。
//
// 用法：
//   node scripts/backup-restore-cli.mjs --help
//   node scripts/backup-restore-cli.mjs backup [--dest <目录>]
//   node scripts/backup-restore-cli.mjs restore <备份目录> [--force]
//
// 行为约束（与协作验收要求一致）：
//   - 仅支持离线备份：备份/恢复前强制检查服务端端口(PORT,默认3000)是否被监听，运行中一律拒绝（无旁路参数）。
//   - 备份：拒绝目标与任何源目录重叠；写入临时目录 + manifest(时间戳/文件清单/SHA-256)后原子改名；
//           失败不留下可被误认为完整的备份。
//   - 恢复：先校验 manifest 与各文件校验和，失败拒绝；目标已有数据默认拒绝覆盖，需 --force；
//           覆盖前自动生成独立的「恢复前备份」；恢复走临时目录 + 可回滚替换，失败回滚到该快照。
import { createHash } from 'node:crypto'
import { createReadStream, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

// ---------- 路径解析（与 src/config.ts 保持一致） ----------
const CWD = process.cwd()
const DATA_DIR = process.env.DATA_DIR
  ? resolve(process.env.DATA_DIR)
  : existsSync('/data')
    ? '/data'
    : resolve(CWD, 'data')
const UPLOAD_DIR = join(DATA_DIR, 'uploads')
const NOTES_DIR = process.env.NOTES_DIR ? resolve(process.env.NOTES_DIR) : join(DATA_DIR, 'notes')
const PORT = Number(process.env.PORT ?? 3000)

function parseDbPath(urlStr) {
  const s = String(urlStr ?? '')
  if (s.startsWith('file:')) {
    try { return fileURLToPath(s) } catch {
      let p = s.slice(5).replace(/^file:\/\//, '')
      const qi = p.indexOf('?')
      if (qi >= 0) p = p.slice(0, qi)
      return resolve(p.replace(/^\/+/, ''))
    }
  }
  return resolve(s)
}
const DB_FILE = process.env.DATABASE_URL ? parseDbPath(process.env.DATABASE_URL) : join(DATA_DIR, 'tagtime.db')
const DB_SUFFIXES = ['', '-wal', '-shm']

// ---------- 工具 ----------
function err(msg) { console.error(`[backup] 错误：${msg}`); process.exit(1) }
function info(msg) { console.log(`[backup] ${msg}`) }
function warn(msg) { console.warn(`[backup] 警告：${msg}`) }

function sha256(file) {
  const h = createHash('sha256')
  return new Promise((res, rej) => {
    const rs = createReadStream(file)
    rs.on('error', rej)
    rs.on('data', (c) => h.update(c))
    rs.on('end', () => res(h.digest('hex')))
  })
}
async function fileMeta(abs) {
  const st = statSync(abs)
  return { path: abs, size: st.size, sha256: await sha256(abs) }
}
function walkFiles(dir) {
  const out = []
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, name.name)
    if (name.isDirectory()) out.push(...walkFiles(abs))
    else if (name.isFile()) out.push(abs)
  }
  return out
}
function isInside(child, parent) {
  const r = relative(parent, child)
  return r === '' || (!r.startsWith('..') && r !== sep && !r.startsWith('..' + sep))
}
function fmtTs() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}
function listenCheck(port) {
  return new Promise((res) => {
    const probe = (host) => new Promise((r) => {
      const sock = net.connect({ port, host })
      sock.setTimeout(600)
      sock.once('connect', () => { sock.destroy(); r(true) })
      sock.once('error', () => r(false))
      sock.once('timeout', () => { sock.destroy(); r(false) })
    })
    Promise.all(['127.0.0.1', '::1'].map(probe)).then((vals) => res(vals.some(Boolean)))
  })
}
async function assertNotRunning() {
  if (await listenCheck(PORT)) err(`检测到服务端可能正在运行(PORT=${PORT})。为保护数据一致性，请先停止服务再执行备份/恢复。`)
}

// ---------- 受控路径：阻止 manifest 路径穿越 ----------
// 仅接受已知基目录下的安全相对路径：拒绝绝对路径、驱动符段与 ".." 段，且 resolve 后须落在基目录内
function safeJoin(base, rel) {
  if (typeof rel !== 'string' || rel === '') throw new Error(`非法相对路径（空）：${rel}`)
  const norm = rel.replace(/\\/g, '/')
  if (norm.startsWith('/') || /^[A-Za-z]:/.test(norm)) throw new Error(`非法绝对路径：${rel}`)
  const parts = norm.split('/').filter(Boolean)
  if (parts.includes('..')) throw new Error(`非法路径穿越（..）：${rel}`)
  if (parts.includes('.')) throw new Error(`非法路径段（.）：${rel}`)
  let out = resolve(base)
  for (const p of parts) {
    if (/^[A-Za-z]:$/.test(p)) throw new Error(`非法路径段（驱动符）：${rel}`)
    out = resolve(join(out, p))
  }
  if (!isInside(out, base)) throw new Error(`路径越出基目录：${rel}`)
  return out
}
function isHex64(v) { return typeof v === 'string' && /^[0-9a-fA-F]{64}$/.test(v) }
function validateManifest(m) {
  if (!m || typeof m !== 'object') err('manifest 不是对象，拒绝恢复。')
  if (m.tool !== 'tagtime-backup' || m.kind !== 'backup') err('manifest 工具/类型不匹配，拒绝恢复。')
  if (m.version !== 1) err(`manifest 版本不受支持：${m.version}`)
  for (const k of ['database', 'notes', 'uploads']) {
    const s = m[k]
    if (!s || typeof s !== 'object' || !Array.isArray(s.files)) err(`manifest 缺少或格式错误的 section：${k}`)
  }
  const dbBase = basename(DB_FILE)
  const allowed = new Set([dbBase, dbBase + '-wal', dbBase + '-shm'])
  for (const f of m.database.files) {
    if (!f || typeof f.file !== 'string' || !allowed.has(f.file)) err(`manifest 包含非法数据库文件名：${f?.file}`)
    if (!isHex64(f.sha256)) err(`manifest 数据库文件校验和非法：${f?.file}`)
  }
  if (!m.database.files.some((f) => f.file === dbBase)) err('备份缺少 SQLite 主库文件，拒绝恢复。')
  for (const sec of ['notes', 'uploads']) {
    for (const f of m[sec].files) {
      if (!f || !isHex64(f.sha256)) err(`manifest ${sec} 文件校验和非法。`)
      try { safeJoin(sec, f.rel) } catch (e) { err(`manifest ${sec} 含非法路径（${e.message}）。`) }
    }
  }
}

// ---------- 备份 ----------
async function doCopyDb(srcBase, destDir) {
  const files = []
  for (const suf of DB_SUFFIXES) {
    const src = srcBase + suf
    if (existsSync(src)) {
      const dst = join(destDir, basename(src))
      cpSync(src, dst)
      files.push({ suffix: suf, src: basename(src) })
    }
  }
  return files
}
async function collectManifestSections(dbDestDir, notesDest, uploadsDest) {
  const dbFiles = []
  for (const suf of DB_SUFFIXES) {
    const src = DB_FILE + suf
    if (existsSync(src)) dbFiles.push(await fileMeta(src))
  }
  const notesRel = []
  for (const f of walkFiles(notesDest)) {
    if (basename(f) === 'manifest.json') continue
    const m = await sha256(f)
    notesRel.push({ rel: relative(notesDest, f), size: statSync(f).size, sha256: m })
  }
  notesRel.sort((a, b) => a.rel.localeCompare(b.rel))
  const upRel = []
  for (const f of walkFiles(uploadsDest)) upRel.push({ rel: relative(uploadsDest, f), size: statSync(f).size, sha256: await sha256(f) })
  upRel.sort((a, b) => a.rel.localeCompare(b.rel))
  return { dbFiles, notesRel, upRel }
}
function manifestFor(sections) {
  return {
    tool: 'tagtime-backup',
    kind: 'backup',
    version: 1,
    createdAt: new Date().toISOString(),
    database: { file: basename(DB_FILE), suffixes: DB_SUFFIXES.filter((s) => existsSync(DB_FILE + s)), files: sections.dbFiles.map((f) => ({ file: basename(f.path), size: f.size, sha256: f.sha256 })) },
    notes: { baseDir: NOTES_DIR, count: sections.notesRel.length, files: sections.notesRel },
    uploads: { baseDir: UPLOAD_DIR, count: sections.upRel.length, files: sections.upRel },
    dataDir: DATA_DIR,
  }
}
async function doBackup(destRaw, { silent }) {
  await assertNotRunning()
  const dest = resolve(destRaw)
  // 路径重叠校验：目标不得落在 notes/uploads 目录内部（否则递归自包含）；也不得覆盖 db 文件。
  for (const root of [NOTES_DIR, UPLOAD_DIR]) {
    if (isInside(dest, root)) err(`备份目标(${dest})落在数据目录(${root})内部，存在自包含/覆盖风险，已拒绝。请指定该目录之外的 --dest。`)
  }
  if (dest === DB_FILE) err('备份目标不得覆盖 SQLite 主库文件。')
  if (existsSync(dest)) err(`备份目标已存在：${dest}。请更换 --dest 或先移除旧备份。`)
  const hasAny = existsSync(DB_FILE) || existsSync(NOTES_DIR) && readdirSync(NOTES_DIR).length > 0 || existsSync(UPLOAD_DIR) && readdirSync(UPLOAD_DIR).length > 0
  if (!hasAny) err('没有可备份的数据（数据库文件与 notes/uploads 均为空）。')
  if (!existsSync(DB_FILE)) err('缺少 SQLite 主库文件：' + DB_FILE)

  mkdirSync(dirname(dest), { recursive: true })
  const tmp = dest + '.tmp-' + fmtTs()
  try {
    mkdirSync(tmp, { recursive: true })
    const notesTmp = join(tmp, 'notes')
    const upTmp = join(tmp, 'uploads')
    mkdirSync(notesTmp, { recursive: true })
    mkdirSync(upTmp, { recursive: true })
    await doCopyDb(DB_FILE, tmp)
    if (existsSync(NOTES_DIR)) for (const f of walkFiles(NOTES_DIR)) cpSync(f, join(notesTmp, relative(NOTES_DIR, f)), { recursive: true })
    if (existsSync(UPLOAD_DIR)) for (const f of walkFiles(UPLOAD_DIR)) cpSync(f, join(upTmp, relative(UPLOAD_DIR, f)))
    const sections = await collectManifestSections(tmp, notesTmp, upTmp)
    const manifest = manifestFor(sections)
    writeFileSync(join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2))
    renameSync(tmp, dest)
    if (!silent) {
      info(`备份完成：${dest}`)
      info(`  SQLite: ${manifest.database.files.length} 个文件；notes: ${sections.notesRel.length} 个；uploads: ${sections.upRel.length} 个`)
      info(`  创建时间：${manifest.createdAt}`)
    }
    return dest
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true })
    throw e
  }
}

// ---------- 恢复 ----------
function loadManifest(srcDir) {
  const mp = join(srcDir, 'manifest.json')
  if (!existsSync(mp)) err(`不是有效的备份目录（缺少 manifest.json）：${srcDir}`)
  let m
  try { m = JSON.parse(readFileSync(mp, 'utf8')) } catch { err('manifest.json 无法解析，可能是损坏的备份。') }
  validateManifest(m)
  return m
}
async function verifyChecksums(srcDir, manifest) {
  const checkOne = async (abs, label, sha) => {
    if (!existsSync(abs)) throw new Error(`备份文件缺失：${label}`)
    const got = await sha256(abs)
    if (got !== sha) throw new Error(`校验和不一致：${label}（期望 ${sha}，实际 ${got}）`)
  }
  const dbBase = basename(DB_FILE)
  // 全部使用验证后的受控路径
  for (const f of manifest.database.files) {
    await checkOne(safeJoin(srcDir, f.file), f.file, f.sha256)
  }
  for (const f of manifest.notes.files) {
    await checkOne(safeJoin(join(srcDir, 'notes'), f.rel), `notes/${f.rel}`, f.sha256)
  }
  for (const f of manifest.uploads.files) {
    await checkOne(safeJoin(join(srcDir, 'uploads'), f.rel), `uploads/${f.rel}`, f.sha256)
  }
}
function targetHasDataNow() {
  const dbHas = DB_SUFFIXES.some((s) => existsSync(DB_FILE + s))
  return dbHas || (existsSync(NOTES_DIR) && readdirSync(NOTES_DIR).length > 0) || (existsSync(UPLOAD_DIR) && readdirSync(UPLOAD_DIR).length > 0)
}
function replaceDir(fromTmp, target) {
  const park = target + '.pre-restore-move'
  rmSync(park, { recursive: true, force: true })
  if (existsSync(target)) renameSync(target, park)
  try { renameSync(fromTmp, target); rmSync(park, { recursive: true, force: true }) }
  catch (e) { if (existsSync(park) && !existsSync(target)) renameSync(park, target); throw e }
}
function replaceFile(fromTmp, target) {
  const park = target + '.pre-restore-move'
  rmSync(park, { force: true })
  if (existsSync(target)) renameSync(target, park)
  try { renameSync(fromTmp, target); rmSync(park, { force: true }) }
  catch (e) { if (existsSync(park) && !existsSync(target)) renameSync(park, target); throw e }
}
function baseSuffix(name) { return name.endsWith('-wal') ? '-wal' : name.endsWith('-shm') ? '-shm' : '' }
function assignCopy(src, dst) { mkdirSync(dirname(dst), { recursive: true }); cpSync(src, dst) }
// 恢复临时目录与各替换目标同卷（避免 EXDEV）；开通 BACKUP_RESTORE_STAGING=os-tmp 用于测试跨卷安全失败
function stageRootFor(targetDir) {
  return process.env.BACKUP_RESTORE_STAGING === 'os-tmp' ? tmpdir() : dirname(targetDir)
}
async function applyRestore(srcDir, manifest) {
  const dbBase = basename(DB_FILE)
  let notesRoot, upRoot, dbDir
  try {
    // notes（与 dirname(NOTES_DIR) 同卷 staging）
    notesRoot = mkdtempSync(join(stageRootFor(NOTES_DIR), '.tagtime-stage-'))
    const stageNotes = join(notesRoot, 'notes')
    mkdirSync(stageNotes, { recursive: true })
    for (const f of manifest.notes.files) assignCopy(safeJoin(join(srcDir, 'notes'), f.rel), join(stageNotes, f.rel))
    // uploads
    upRoot = mkdtempSync(join(stageRootFor(UPLOAD_DIR), '.tagtime-stage-'))
    const stageUp = join(upRoot, 'uploads')
    mkdirSync(stageUp, { recursive: true })
    for (const f of manifest.uploads.files) assignCopy(safeJoin(join(srcDir, 'uploads'), f.rel), join(stageUp, f.rel))
    // db 文件（与 dirname(DB_FILE) 同卷 staging）
    mkdirSync(dirname(DB_FILE), { recursive: true })
    dbDir = mkdtempSync(join(stageRootFor(dirname(DB_FILE)), '.tagtime-stage-'))
    for (const f of manifest.database.files) assignCopy(safeJoin(srcDir, f.file), join(dbDir, f.file))
    // 全部 staging 就绪后原子替换
    replaceDir(stageNotes, NOTES_DIR)
    replaceDir(stageUp, UPLOAD_DIR)
    const present = new Set(manifest.database.files.map((f) => f.file))
    for (const f of manifest.database.files) replaceFile(join(dbDir, f.file), DB_FILE + baseSuffix(f.file))
    // 移除备份未包含的旧 -wal/-shm，避免与新主库不一致
    for (const suf of DB_SUFFIXES) {
      if (suf !== '' && !present.has(dbBase + suf)) rmSync(DB_FILE + suf, { force: true })
    }
  } finally {
    if (notesRoot) rmSync(notesRoot, { recursive: true, force: true })
    if (upRoot) rmSync(upRoot, { recursive: true, force: true })
    if (dbDir) rmSync(dbDir, { recursive: true, force: true })
  }
}
async function rollbackToPre(src) {
  const m = loadManifest(src)
  await verifyChecksums(src, m)
  await applyRestore(src, m)
  info(`已回滚到恢复前备份：${src}`)
}
async function doRestore(srcRaw, { force }) {
  await assertNotRunning()
  const srcDir = resolve(srcRaw)
  const manifest = loadManifest(srcDir)
  await verifyChecksums(srcDir, manifest)

  const hasExisting = targetHasDataNow()
  if (hasExisting && !force) err(`目标目录已有数据。为避免覆盖用户数据，默认拒绝；如确认要覆盖，请加 --force。`)

  let preDir = null
  if (hasExisting && force) {
    preDir = join(DATA_DIR, 'backups', 'pre-restore-' + fmtTs())
    info('覆盖前先自动生成「恢复前备份」……')
    preDir = await doBackup(preDir, { silent: true })
  }

  try {
    await applyRestore(srcDir, manifest)
  } catch (e) {
    info('恢复过程中出错，尝试回滚到恢复前快照……')
    if (preDir) { try { await rollbackToPre(preDir) } catch (e2) { err(`回滚失败：${e2.message}。可用此备份手动恢复：${preDir}`) } }
    err(`恢复失败：${e.message}${preDir ? `；已保留恢复前备份于 ${preDir}` : ''}`)
  }
  info(`恢复完成（来自：${srcDir}）${preDir ? `；恢复前备份：${preDir}` : ''}`)
}

// ---------- CLI 解析 ----------
function usage() {
  console.log(`TagTime 离线备份/恢复 CLI

用法：
  backup-restore-cli.mjs backup [--dest <目录>]
  backup-restore-cli.mjs restore <备份目录> [--force]
  backup-restore-cli.mjs --help

子命令：
  backup    把 SQLite 主库(-wal/-shm)、notes/ 与 uploads/ 备份到 --dest（默认：<DATA_DIR>/backups/backup-<时间戳>）
            · 要求服务端未运行，运行中拒绝（无旁路参数）
            · 目标目录不得落在数据目录内部，避免自包含
  restore   从 <备份目录> 校验并恢复全部数据
            · 要求服务端未运行；默认要求目标无已有数据，需 --force 覆盖（覆盖前自动生成恢复前备份）
            · 校验 manifest 与 SHA-256，失败拒绝

环境变量：DATA_DIR、NOTES_DIR、DATABASE_URL、PORT（服务运行检测用，默认 3000）`)
}
function arg(argv, name, needValue) {
  const i = argv.indexOf(name)
  if (i < 0) return needValue ? null : false
  return needValue ? (argv[i + 1] ?? null) : true
}
function has(argv, name) { return argv.includes(name) }

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || has(argv, '--help') || has(argv, '-h')) { usage(); return }
  const cmd = argv[0]
  if (cmd === 'backup') {
    const dest = arg(argv, '--dest', true) || join(DATA_DIR, 'backups', 'backup-' + fmtTs())
    await doBackup(dest, {})
  } else if (cmd === 'restore') {
    const src = argv[1]
    if (!src || src.startsWith('-')) err('restore 需要指定备份目录。')
    const force = has(argv, '--force') || has(argv, '--overwrite')
    await doRestore(src, { force })
  } else {
    err(`未知子命令：${cmd}。请用 --help 查看用法。`)
  }
}

main().catch((e) => { console.error('[backup] 致命错误：' + (e?.message || e)); process.exit(1) })