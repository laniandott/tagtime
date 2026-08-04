import { PrismaClient } from '@prisma/client'

// 屏蔽 Prisma 联网引擎检查，完全启用本地离线引擎
process.env.PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING = '1'

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'file:./data/tagtime.db'
}

const prisma = new PrismaClient()

export default prisma
