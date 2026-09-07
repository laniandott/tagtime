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
//           覆盖前自动生成独立的「恢复前备份」；恢复走事务式替换，任一步失败即回滚到替换前状态。
import { createHash } from 'node:crypto'
import { createReadStream, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
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
const persistedNotesDir = (() => {
  if (process.env.NOTES_DIR) return null
  try {
    const configured = JSON.parse(readFileSync(join(DATA_DIR, 'notes-config.json'), 'utf8')).notesDir
    if (typeof configured !== 'string' || !isAbsolute(configured) || !statSync(configured).isDirectory()) return null
    return resolve(configured)
  } catch {
    return null
  }
})()
const NOTES_DIR = process.env.NOTES_DIR ? resolve(process.env.NOTES_DIR) : persistedNotesDir ?? join(DATA_DIR, 'notes')
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
function validSize(v) { return Number.isInteger(v) && v >= 0 }
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
  const seen = new Set()
  for (const f of m.database.files) {
    if (!f || typeof f.file !== 'string' || !allowed.has(f.file)) err(`manifest 包含非法数据库文件名：${f?.file}`)
    if (seen.has(f.file)) err(`manifest 数据库文件名重复：${f.file}`)
    seen.add(f.file)
    if (!isHex64(f.sha256)) err(`manifest 数据库文件校验和非法：${f?.file}`)
    if (!validSize(f.size)) err(`manifest 数据库文件大小非法：${f?.file}`)
  }
  if (!m.database.files.some((f) => f.file === dbBase)) err('备份缺少 SQLite 主库文件，拒绝恢复。')
  for (const sec of ['notes', 'uploads']) {
    const relSeen = new Set()
    for (const f of m[sec].files) {
      if (!f || !isHex64(f.sha256)) err(`manifest ${sec} 文件校验和非法。`)
      if (!validSize(f.size)) err(`manifest ${sec} 文件大小非法。`)
      if (relSeen.has(f.rel)) err(`manifest ${sec} 文件路径重复：${f.rel}`)
      relSeen.add(f.rel)
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
    if (existsSync(NOTES_DIR)) for (const f of walkFiles(NOTES_DIR)) assignCopy(f, join(notesTmp, relative(NOTES_DIR, f)))
    if (existsSync(UPLOAD_DIR)) for (const f of walkFiles(UPLOAD_DIR)) assignCopy(f, join(upTmp, relative(UPLOAD_DIR, f)))
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
  const checkOne = async (abs, label, size, sha) => {
    if (!existsSync(abs)) throw new Error(`备份文件缺失：${label}`)
    const st = statSync(abs)
    if (st.size !== size) throw new Error(`文件大小不一致：${label}（期望 ${size}，实际 ${st.size}）`)
    const got = await sha256(abs)
    if (got !== sha) throw new Error(`校验和不一致：${label}（期望 ${sha}，实际 ${got}）`)
  }
  const dbBase = basename(DB_FILE)
  // 全部使用验证后的受控路径
  for (const f of manifest.database.files) {
    await checkOne(safeJoin(srcDir, f.file), f.file, f.size, f.sha256)
  }
  for (const f of manifest.notes.files) {
    await checkOne(safeJoin(join(srcDir, 'notes'), f.rel), `notes/${f.rel}`, f.size, f.sha256)
  }
  for (const f of manifest.uploads.files) {
    await checkOne(safeJoin(join(srcDir, 'uploads'), f.rel), `uploads/${f.rel}`, f.size, f.sha256)
  }
}
function targetHasDataNow() {
  const dbHas = DB_SUFFIXES.some((s) => existsSync(DB_FILE + s))
  return dbHas || (existsSync(NOTES_DIR) && readdirSync(NOTES_DIR).length > 0) || (existsSync(UPLOAD_DIR) && readdirSync(UPLOAD_DIR).length > 0)
}
function baseSuffix(name) { return name.endsWith('-wal') ? '-wal' : name.endsWith('-shm') ? '-shm' : '' }
function assignCopy(src, dst) { mkdirSync(dirname(dst), { recursive: true }); cpSync(src, dst) }
// 测试专用故障注入：仅在显式声明测试 runner 时生效（TAGTIME_TEST_RUNNER=1），生产环境不读取。
// 支持点位于替换事务的不同阶段：after_park_<N>（Phase A 第 N 个目标移入 park 后）、
// after_notes/after_uploads（Phase B 落位后）、cleanup_fail（Phase C 清理时）。
const TEST_RUNNER = process.env.TAGTIME_TEST_RUNNER === '1'
const TEST_FAILPOINT = TEST_RUNNER ? (process.env.BACKUP_RESTORE_TEST_FAILPOINT || null) : null
function failNow(point) { if (TEST_FAILPOINT === point) throw new Error('test-failpoint:' + point) }
// 恢复采用事务式替换：staging 一律建在各目标同卷（rename 不跨卷）。
// Phase A 把现有目标（notes/uploads/主库/-wal/-shm）各自移入同卷 park 保留；
// Phase B 逐一落位新数据；两阶段任一步失败都走 rollbackRestore() 整体还原。
// Phase C 为提交后清理：仅在全部落位后删除 parks，失败只提示“待清理”，不伪装成可回滚失败。
async function applyRestore(srcDir, manifest) {
  const dbBase = basename(DB_FILE)
  let notesRoot, upRoot, dbDir
  try {
    // 1) 各目标同卷 staging，先完整复制新数据
    notesRoot = mkdtempSync(join(dirname(NOTES_DIR), '.tagtime-stage-'))
    const stageNotes = join(notesRoot, 'notes')
    mkdirSync(stageNotes, { recursive: true })
    for (const f of manifest.notes.files) assignCopy(safeJoin(join(srcDir, 'notes'), f.rel), join(stageNotes, f.rel))
    upRoot = mkdtempSync(join(dirname(UPLOAD_DIR), '.tagtime-stage-'))
    const stageUp = join(upRoot, 'uploads')
    mkdirSync(stageUp, { recursive: true })
    for (const f of manifest.uploads.files) assignCopy(safeJoin(join(srcDir, 'uploads'), f.rel), join(stageUp, f.rel))
    mkdirSync(dirname(DB_FILE), { recursive: true })
    dbDir = mkdtempSync(join(dirname(DB_FILE), '.tagtime-stage-'))
    for (const f of manifest.database.files) assignCopy(safeJoin(srcDir, f.file), join(dbDir, f.file))

    // 2) 替换单元：notes/uploads 目录、主库 + 备份内含的 sidecar；备份未含的旧 sidecar 视为“替换为空”
    const present = new Set(manifest.database.files.map((f) => f.file))
    const units = [
      { from: stageNotes, to: NOTES_DIR },
      { from: stageUp, to: UPLOAD_DIR },
    ]
    for (const f of manifest.database.files) units.push({ from: join(dbDir, f.file), to: DB_FILE + baseSuffix(f.file) })
    for (const suf of DB_SUFFIXES) {
      if (suf !== '' && !present.has(dbBase + suf)) units.push({ from: null, to: DB_FILE + suf })
    }
    for (const u of units) { u.hadOriginal = existsSync(u.to); u.park = u.to + '.tagt-restore-park'; u.placed = false }

    try {
      // 3) Phase A：把现有目标移入同卷 park，保留原数据
      let parked = 0
      for (const u of units) {
        if (!u.hadOriginal) continue
        renameSync(u.to, u.park)
        parked++
        failNow('after_park_' + parked)
      }
      // 4) Phase B：落位新数据
      for (const u of units) {
        if (u.from === null) continue
        renameSync(u.from, u.to)
        u.placed = true
        const label = u.to === NOTES_DIR ? 'notes' : u.to === UPLOAD_DIR ? 'uploads' : null
        if (label) failNow('after_' + label)
      }
    } catch (e) {
      // 5) 回滚（覆盖 Phase A/Phase B 任意失败点，幂等）：
      //    - 原数据已在 park → 清除本事务放入的新目标后用 park 还原；
      //    - 原目标为空但已 move-in → 移除新数据以恢复"空"；
      //    - 尚未 park/move-in 的单元保持原状。
      for (const u of units) {
        if (u.placed && !existsSync(u.park)) rmSync(u.to, { recursive: true, force: true })
      }
      for (const u of units) {
        if (existsSync(u.park)) {
          rmSync(u.to, { recursive: true, force: true })
          renameSync(u.park, u.to)
        }
      }
      throw e
    }

    // 6) Phase C：提交完成 → 幂等清理 parks；失败只保留可恢复 park 并提示，不报“恢复失败”
    const pending = []
    for (const u of units) {
      if (!u.hadOriginal) continue
      try { failNow('cleanup_fail'); rmSync(u.park, { recursive: true, force: true }) }
      catch { pending.push(u.park) }
    }
    if (pending.length) info(`恢复已提交，但以下暂存残留未能清理（可手动删除，或下次恢复时重试）：${pending.join('、')}`)
  } finally {
    if (notesRoot) rmSync(notesRoot, { recursive: true, force: true })
    if (upRoot) rmSync(upRoot, { recursive: true, force: true })
    if (dbDir) rmSync(dbDir, { recursive: true, force: true })
  }
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
    // 事务式 applyRestore 已在 Phase A/B 内部用 parks 回滚；Phase C 只报告“已提交待清理”
    await applyRestore(srcDir, manifest)
  } catch (e) {
    const hint = preDir ? `；已生成恢复前备份于 ${preDir}，可用于手动恢复` : ''
    err(`恢复失败：${e.message}${hint}`)
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
            · 目标不得落在 notes/uploads 目录内部，也不得直接覆盖数据库文件
  restore   从 <备份目录> 校验并恢复全部数据
            · 要求服务端未运行；默认要求目标无已有数据，需 --force 覆盖（覆盖前自动生成恢复前备份）
            · 校验 manifest 与 SHA-256，失败拒绝；替换失败自动回滚到替换前状态

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
