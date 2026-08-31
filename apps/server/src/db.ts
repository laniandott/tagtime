import { PrismaClient } from '@prisma/client'

// 屏蔽 Prisma 联网引擎检查，完全启用本地离线引擎
process.env.PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING = '1'
// Prisma WASM schema engine 在无 RUST_LOG（或依赖调用者 shell 状态）时，Windows 下偶发 Schema engine error。
// 这里固定一个稳定值，使启动与测试行为不随外部环境漂移。
process.env.RUST_LOG ??= 'info'

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'file:./data/tagtime.db'
}

const prisma = new PrismaClient()

export default prisma
