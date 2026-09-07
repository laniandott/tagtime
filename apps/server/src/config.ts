import { dirname, join, resolve, isAbsolute } from 'node:path'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// 统一数据目录解析：与上传目录(memos)共用同一规则
// 优先级：DATA_DIR 环境变量 > 容器内 /data > 项目根目录下 data。
// 不能使用 process.cwd()：npm workspace 启动 server 时 cwd 是 apps/server，
// 会把正式数据误放到 apps/server/data。
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const DATA_DIR = process.env.DATA_DIR
  ? resolve(process.env.DATA_DIR)
  : existsSync('/data')
  ? '/data'
  : resolve(projectRoot, 'data')

const UPLOAD_DIR = join(DATA_DIR, 'uploads')

// 写入接口的内容上限（按 JavaScript 字符数计算；请求体另有字节上限）。
const CONTENT_LIMITS = {
  NOTE_TITLE: 200,
  NOTE_CONTENT: 900_000,
  MEMO_CONTENT: 50_000,
  TIMER_NOTE: 1_000,
} as const

// 允许 900,000 个字符的笔记携带 JSON 字段；中文/emoji 的 UTF-8 字节数会高于字符数。
const BODY_SIZE_LIMIT = 4 * 1024 * 1024

// 笔记目录：环境变量 > DATA_DIR/notes-config.json > DATA_DIR/notes。
// 环境变量适合容器/部署场景；桌面端可通过 API 持久化切换到本机 Obsidian Vault。
const NOTES_CONFIG_FILE = join(DATA_DIR, 'notes-config.json')
const notesDirFromEnv = process.env.NOTES_DIR?.trim()
const notesDirIsEnvLocked = Boolean(notesDirFromEnv)

function existingDirectory(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const input = value.trim()
  if (!isAbsolute(input)) return null
  const candidate = resolve(input)
  try {
    return statSync(candidate).isDirectory() ? candidate : null
  } catch {
    return null
  }
}

function persistedNotesDir(): string | null {
  try {
    const parsed = JSON.parse(readFileSync(NOTES_CONFIG_FILE, 'utf8')) as { notesDir?: unknown }
    return existingDirectory(parsed.notesDir)
  } catch {
    return null
  }
}

export let NOTES_DIR = notesDirFromEnv
  ? resolve(notesDirFromEnv)
  : persistedNotesDir() ?? join(DATA_DIR, 'notes')

export function getNotesDir(): string {
  return NOTES_DIR
}

export function notesDirUsesEnvironment(): boolean {
  return notesDirIsEnvLocked
}

export function validateNotesDir(value: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('需要文件库路径')
  const input = value.trim()
  if (!isAbsolute(input)) throw new Error('文件库路径必须是绝对路径')
  const candidate = resolve(input)
  if (!existsSync(candidate) || !statSync(candidate).isDirectory()) {
    throw new Error('文件库路径不存在或不是文件夹')
  }
  return candidate
}

export function setNotesDir(value: string): string {
  if (notesDirIsEnvLocked) throw new Error('当前由 NOTES_DIR 环境变量固定文件库路径')
  const candidate = validateNotesDir(value)
  writeFileSync(NOTES_CONFIG_FILE, `${JSON.stringify({ notesDir: candidate }, null, 2)}\n`, 'utf8')
  NOTES_DIR = candidate
  return candidate
}

// 启动时幂等创建所需目录
for (const dir of [UPLOAD_DIR, NOTES_DIR]) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

export { DATA_DIR, UPLOAD_DIR, CONTENT_LIMITS, BODY_SIZE_LIMIT, NOTES_CONFIG_FILE }
