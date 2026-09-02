import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const prismaCli = require.resolve('prisma/build/index.js')

export function pushTestSchema(serverRoot: string, databaseUrl: string): void {
  execFileSync(
    process.execPath,
    [prismaCli, 'db', 'push', '--skip-generate', '--schema', 'src/schema.prisma'],
    {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl, RUST_LOG: 'info' },
      stdio: 'pipe',
    },
  )
}
