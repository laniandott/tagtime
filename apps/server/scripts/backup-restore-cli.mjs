#!/usr/bin/env node
// TagTime 离线备份 / 恢复 CLI
//
// 用途：在服务端进程停止的前提下，将全部持久化用户数据（SQLite 主库及 -wal/-shm、
//       NOTES_DIR 下 Markdown、DATA_DIR/uploads 下附件）备份到指定目录，或从备份恢复。
//
// 用法：
//   node scripts/backup-restore-cli.mjs --help
//   node scripts/backup-restore-cli.mjs backup [--dest <目录>] [--ignore-running]
//   node scripts/backup-restore-cli.mjs restore <备份目录> [--force] [--ignore-running]
//
// 行为约束（与协作验收要求一致）：
//   - 仅支持离线备份：备份/恢复前默认检查服务端端口(PORT,默认3000)是否被监听，运行中则拒绝。
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
async function assertNotRunning(ignore) {
  if (await listenCheck(PORT)) {
    if (ignore) warn(`检测到服务端可能正在运行(PORT=${PORT})；你已用 --ignore-running 忽略，继续执行风险自负。`)
    else err(`检测到服务端可能正在运行(PORT=${PORT})。请先停止服务再执行；若确认无实例，可加 --ignore-running 强制继续。`)
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
async function doBackup(destRaw, { ignoreRunning, silent }) {
  await assertNotRunning(ignoreRunning)
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
  if (m?.tool !== 'tagtime-backup' || m?.kind !== 'backup') err('manifest 工具/类型不匹配，拒绝恢复。')
  return m
}
async function verifyChecksums(srcDir, manifest) {
  const checkOne = async (relPath, sha) => {
    const abs = join(srcDir, relPath)
    if (!existsSync(abs)) throw new Error(`备份文件缺失：${relPath}`)
    const got = await sha256(abs)
    if (got !== sha) throw new Error(`校验和不一致：${relPath}（期望 ${sha}，实际 ${got}）`)
  }
  const jobs = []
  for (const f of manifest.database.files) jobs.push(checkOne(f.file, f.sha256))
  for (const f of manifest.notes.files) jobs.push(checkOne(join('notes', f.rel), f.sha256))
  for (const f of manifest.uploads.files) jobs.push(checkOne(join('uploads', f.rel), f.sha256))
  for (const j of jobs) await j
}
function targetHasDataNow() {
  return existsSync(DB_FILE) || (existsSync(NOTES_DIR) && readdirSync(NOTES_DIR).length > 0) || (existsSync(UPLOAD_DIR) && readdirSync(UPLOAD_DIR).length > 0)
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
async function applyRestore(srcDir, manifest, staging) {
  const notesStaging = join(staging, 'notes')
  const upStaging = join(staging, 'uploads')
  mkdirSync(notesStaging, { recursive: true })
  mkdirSync(upStaging, { recursive: true })
  mkdirSync(NOTES_DIR, { recursive: true })
  mkdirSync(UPLOAD_DIR, { recursive: true })
  // 先全部复制到 staging，全部就绪后再替换，降低半途失败风险
  for (const f of manifest.notes.files) assignCopy(join(srcDir, 'notes', f.rel), join(notesStaging, f.rel))
  for (const f of manifest.uploads.files) assignCopy(join(srcDir, 'uploads', f.rel), join(upStaging, f.rel))
  for (const f of manifest.database.files) assignCopy(join(srcDir, f.file), join(staging, f.file))
  // 替换目标
  replaceDir(notesStaging, NOTES_DIR)
  replaceDir(upStaging, UPLOAD_DIR)
  for (const f of manifest.database.files) replaceFile(join(staging, f.file), DB_FILE + baseSuffix(f.file))
  rmSync(staging, { recursive: true, force: true })
}
function baseSuffix(name) { return name.endsWith('-wal') ? '-wal' : name.endsWith('-shm') ? '-shm' : '' }
function assignCopy(src, dst) { mkdirSync(dirname(dst), { recursive: true }); cpSync(src, dst) }
async function rollbackToPre(src) {
  const m = loadManifest(src)
  await verifyChecksums(src, m)
  const staging = mkdtempSync(join(tmpdir(), 'tt-restore-rb-'))
  await applyRestore(src, m, staging)
  info(`已回滚到恢复前备份：${src}`)
}
async function doRestore(srcRaw, { force, ignoreRunning }) {
  await assertNotRunning(ignoreRunning)
  const srcDir = resolve(srcRaw)
  const manifest = loadManifest(srcDir)
  await verifyChecksums(srcDir, manifest)

  const hasExisting = targetHasDataNow()
  if (hasExisting && !force) err(`目标目录已有数据。为避免覆盖用户数据，默认拒绝；如确认要覆盖，请加 --force。`)

  let preDir = null
  if (hasExisting && force) {
    preDir = join(DATA_DIR, 'backups', 'pre-restore-' + fmtTs())
    info('覆盖前先自动生成「恢复前备份」……')
    preDir = await doBackup(preDir, { ignoreRunning: true, silent: true })
  }

  const staging = mkdtempSync(join(tmpdir(), 'tt-restore-'))
  try {
    await applyRestore(srcDir, manifest, staging)
  } catch (e) {
    info('恢复过程中出错，尝试回滚到恢复前快照……')
    if (preDir) { try { await rollbackToPre(preDir) } catch (e2) { err(`回滚失败：${e2.message}。可用此备份手动恢复：${preDir}`) } }
    rmSync(staging, { recursive: true, force: true })
    err(`恢复失败：${e.message}${preDir ? `；已保留恢复前备份于 ${preDir}` : ''}`)
  }
  info(`恢复完成（来自：${srcDir}）${preDir ? `；恢复前备份：${preDir}` : ''}`)
}

// ---------- CLI 解析 ----------
function usage() {
  console.log(`TagTime 离线备份/恢复 CLI

用法：
  backup-restore-cli.mjs backup [--dest <目录>] [--ignore-running]
  backup-restore-cli.mjs restore <备份目录> [--force] [--ignore-running]
  backup-restore-cli.mjs --help

子命令：
  backup    把 SQLite 主库(-wal/-shm)、notes/ 与 uploads/ 备份到 --dest（默认：<DATA_DIR>/backups/backup-<时间戳>）
            · 默认要求服务端未运行（--ignore-running 可强制跳过该检查）
            · 目标目录不得落在数据目录内部，避免自包含
  restore   从 <备份目录> 校验并恢复全部数据
            · 默认要求目标无已有数据；要覆盖需 --force（覆盖前自动生成恢复前备份）
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
  const ignoreRunning = has(argv, '--ignore-running')
  if (cmd === 'backup') {
    const dest = arg(argv, '--dest', true) || join(DATA_DIR, 'backups', 'backup-' + fmtTs())
    await doBackup(dest, { ignoreRunning })
  } else if (cmd === 'restore') {
    const src = argv[1]
    if (!src || src.startsWith('-')) err('restore 需要指定备份目录。')
    const force = has(argv, '--force') || has(argv, '--overwrite')
    await doRestore(src, { force, ignoreRunning })
  } else {
    err(`未知子命令：${cmd}。请用 --help 查看用法。`)
  }
}

main().catch((e) => { console.error('[backup] 致命错误：' + (e?.message || e)); process.exit(1) })