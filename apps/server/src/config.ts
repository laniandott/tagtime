import { join, resolve } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'

// 统一数据目录解析：与上传目录(memos)共用同一规则
// 优先级：DATA_DIR 环境变量 > 容器内 /data > 工作目录下 data
const DATA_DIR = process.env.DATA_DIR
  ? resolve(process.env.DATA_DIR)
  : existsSync('/data')
  ? '/data'
  : resolve(process.cwd(), 'data')

const UPLOAD_DIR = join(DATA_DIR, 'uploads')

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

export { DATA_DIR, UPLOAD_DIR, NOTES_DIR }