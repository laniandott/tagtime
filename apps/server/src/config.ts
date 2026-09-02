import { dirname, join, resolve } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
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

// 笔记目录：优先 NOTES_DIR 环境变量，默认由 DATA_DIR 推导
const NOTES_DIR = process.env.NOTES_DIR
  ? resolve(process.env.NOTES_DIR)
  : join(DATA_DIR, 'notes')

// 启动时幂等创建所需目录
for (const dir of [UPLOAD_DIR, NOTES_DIR]) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

export { DATA_DIR, UPLOAD_DIR, NOTES_DIR, CONTENT_LIMITS, BODY_SIZE_LIMIT }
