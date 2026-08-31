// 六-D：离线备份/恢复 CLI 演练（可重复，全部在临时目录隔离运行，不接触用户数据）
// 覆盖场景：备份成功、正常恢复(含覆盖前自动备份)、校验和损坏拒绝、缺少主库拒绝、
//           未确认覆盖拒绝、路径重叠拒绝、服务运行中拒绝(--ignore-running 放行)。
// 用法（仓库根）：npm run backup:cli:drill -w apps/server
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const cliPath = fileURLToPath(new URL('backup-restore-cli.mjs', import.meta.url))
let ok = true
function report(f, label, detail) {
  if (!f) ok = false
  console.log(`[drill] ${f ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`)
}

function runCLI(args, env) {
  return new Promise((res) => {
    execFile(process.execPath, [cliPath, ...args], { env, encoding: 'utf8' }, (err, stdout, stderr) => {
      res({ code: err ? (err.code ?? 1) : 0, stdout, stderr })
    })
  })
}

function makeEnv(tmpRoot, port) {
  const data = join(tmpRoot, 'data')
  const notes = join(data, 'notes')
  const uploads = join(data, 'uploads')
  mkdirSync(notes, { recursive: true })
  mkdirSync(uploads, { recursive: true })
  const db = join(data, 'tagtime.db')
  writeFileSync(db, Buffer.from('SQLite-format-3\0drill-seed'))
  return {
    envObj: {
      DATA_DIR: data,
      NOTES_DIR: notes,
      UPLOAD_DIR: uploads,
      DATABASE_URL: 'file:' + db.replace(/\\/g, '/'),
      PORT: String(port),
    },
    data, notes, uploads, db,
  }
}

function seedData(notePath, upPath) {
  writeFileSync(notePath, '# hello backup', 'utf8')
  writeFileSync(upPath, Buffer.from([1, 2, 3, 4, 5]))
}

void (async () => {
try {
  const basePort = 26900 + Math.floor(Math.random() * 900)

  // ===== S1：备份成功，manifest 与文件齐全 =====
  {
    const t = mkdtempSync(join(tmpdir(), 'tt-cli-s1-')); const E = makeEnv(t, basePort)
    seedData(join(E.notes, 'a.md'), join(E.uploads, 'pic.bin'))
    const dest = join(t, 'backups', 'out')
    const r = await runCLI(['backup', '--dest', dest], E.envObj)
    report(r.code === 0, 'S1 备份命令退出码 0', r.stderr.trim() || r.stdout.split('\n').pop())
    const manifest = existsSync(join(dest, 'manifest.json')) ? JSON.parse(readFileSync(join(dest, 'manifest.json'), 'utf8')) : null
    report(!!manifest, 'S1 生成 manifest.json')
    report(manifest?.database?.files?.length >= 1 && existsSync(join(dest, 'tagtime.db')), 'S1 主库已备份')
    report(manifest?.notes?.count === 1 && existsSync(join(dest, 'notes', 'a.md')), 'S1 notes 已备份')
    report(manifest?.uploads?.count === 1 && existsSync(join(dest, 'uploads', 'pic.bin')), 'S1 uploads 已备份')
    report(manifest?.version === 1 && !!manifest?.createdAt, 'S1 manifest 含版本与时间戳')
    rmSync(t, { recursive: true, force: true })
  }

  // ===== S2：正常恢复成功，且覆盖前自动生成恢复前备份 =====
  {
    const t = mkdtempSync(join(tmpdir(), 'tt-cli-s2-')); const E = makeEnv(t, basePort + 1)
    seedData(join(E.notes, 'a.md'), join(E.uploads, 'pic.bin'))
    const dest = join(t, 'backups', 'out')
    await runCLI(['backup', '--dest', dest], E.envObj)
    // 改动目标：改 notes 内容、删除 upload，制造"目标已有数据"与"被污染"
    writeFileSync(join(E.notes, 'a.md'), '# modified', 'utf8')
    writeFileSync(join(E.notes, 'extra.md'), 'junk', 'utf8')
    rmSync(join(E.uploads, 'pic.bin'), { force: true })
    // 无 --force 应拒绝（覆盖保护）
    const rNoForce = await runCLI(['restore', dest], E.envObj)
    report(rNoForce.code !== 0, 'S2 目标已有数据时无 --force 拒绝覆盖')
    // 加 --force 恢复
    const r = await runCLI(['restore', dest, '--force'], E.envObj)
    report(r.code === 0, 'S2 恢复命令退出码 0', r.stderr.trim() || r.stdout.split('\n').pop())
    report(readFileSync(join(E.notes, 'a.md'), 'utf8') === '# hello backup', 'S2 notes/one 恢复为备份原文')
    report(!existsSync(join(E.notes, 'extra.md')), 'S2 多余的 extra.md 被移除')
    report(existsSync(join(E.uploads, 'pic.bin')), 'S2 uploads/pic 恢复')
    const preDirs = existsSync(join(E.data, 'backups')) ? readdirSync(join(E.data, 'backups')).filter((n) => n.startsWith('pre-restore-')) : []
    report(preDirs.length >= 1, 'S2 覆盖前自动生成恢复前备份', preDirs[0])
    rmSync(t, { recursive: true, force: true })
  }

  // ===== S3：校验和损坏 → 拒绝，且目标数据不变 =====
  {
    const t = mkdtempSync(join(tmpdir(), 'tt-cli-s3-')); const E = makeEnv(t, basePort + 2)
    seedData(join(E.notes, 'a.md'), join(E.uploads, 'pic.bin'))
    const dest = join(t, 'backups', 'out')
    await runCLI(['backup', '--dest', dest], E.envObj)
    // 篡改 manifest 中某文件的 sha256，使恢复前校验必然失败
    const m = JSON.parse(readFileSync(join(dest, 'manifest.json'), 'utf8'))
    if (m.notes.files.length) m.notes.files[0].sha256 = 'f'.repeat(64)
    writeFileSync(join(dest, 'manifest.json'), JSON.stringify(m), 'utf8')
    const before = readFileSync(join(E.notes, 'a.md'), 'utf8')
    // 目标仍为原文数据；--force 下发现在校验阶段即拒绝，替换不应发生
    const r = await runCLI(['restore', dest, '--force'], E.envObj)
    report(r.code !== 0, 'S3 校验和损坏时恢复拒绝')
    report(readFileSync(join(E.notes, 'a.md'), 'utf8') === before, 'S3 原数据未被恢复命令改动')
    rmSync(t, { recursive: true, force: true })
  }

  // ===== S4：缺少主库 → 备份拒绝 =====
  {
    const t = mkdtempSync(join(tmpdir(), 'tt-cli-s4-')); const E = makeEnv(t, basePort + 4)
    rmSync(E.db, { force: true })
    writeFileSync(join(E.notes, 'a.md'), 'x', 'utf8')
    const r = await runCLI(['backup', '--dest', join(t, 'out')], E.envObj)
    report(r.code !== 0 && /主库|数据库/.test(r.stderr + r.stdout), 'S4 缺少主库时备份拒绝', (r.stderr + r.stdout).trim().slice(0, 60))
    rmSync(t, { recursive: true, force: true })
  }

  // ===== S5：路径重叠（dest 落在 notes 内）→ 拒绝 =====
  {
    const t = mkdtempSync(join(tmpdir(), 'tt-cli-s5-')); const E = makeEnv(t, basePort + 5)
    seedData(join(E.notes, 'a.md'), join(E.uploads, 'p.bin'))
    const r = await runCLI(['backup', '--dest', join(E.notes, 'sub')], E.envObj)
    report(r.code !== 0 && /落在数据目录|拒绝/.test(r.stderr + r.stdout), 'S5 目标在 notes 内时备份拒绝', (r.stderr + r.stdout).trim().slice(0, 60))
    rmSync(t, { recursive: true, force: true })
  }

  // ===== S6：服务运行中 → 拒绝；--ignore-running → 放行 =====
  {
    const t = mkdtempSync(join(tmpdir(), 'tt-cli-s6-')); const E = makeEnv(t, basePort + 6)
    seedData(join(E.notes, 'a.md'), join(E.uploads, 'p.bin'))
    const srv = net.createServer(() => {})
    await new Promise((res) => srv.listen(Number(E.envObj.PORT), '127.0.0.1', res))
    const r = await runCLI(['backup', '--dest', join(t, 'out')], E.envObj)
    report(r.code !== 0 && /正在运行|请先停止/.test(r.stderr + r.stdout), 'S6 服务运行中备份被拒绝', (r.stderr + r.stdout).trim().slice(0, 60))
    const r2 = await runCLI(['backup', '--dest', join(t, 'ignored'), '--ignore-running'], E.envObj)
    report(r2.code === 0, 'S6 --ignore-running 放行备份')
    srv.close()
    rmSync(t, { recursive: true, force: true })
  }

  console.log(ok ? '[drill] 结果：通过（CLI 备份/恢复 6 场景）' : '[drill] 结果：存在失败')
} catch (e) {
  ok = false
  console.error('[drill] 失败:', e.message || e)
}
process.exit(ok ? 0 : 1)
})().catch((e) => { console.error('[drill] 致命错误:', e); process.exit(2) })