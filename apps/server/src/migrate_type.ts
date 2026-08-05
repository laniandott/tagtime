import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: 'file:F:/项目/tagtime/data/tagtime.db',
    },
  },
})

async function main() {
  try {
    await prisma.$executeRawUnsafe(`ALTER TABLE Memo ADD COLUMN type TEXT DEFAULT 'diary'`)
    console.log('✅ Column type successfully added to Memo table!')
  } catch (e: any) {
    if (e.message.includes('duplicate column name')) {
      console.log('ℹ️ Column type already exists.')
    } else {
      console.error('Error adding column:', e)
    }
  }
}

main()
