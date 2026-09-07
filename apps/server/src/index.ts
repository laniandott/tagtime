import Fastify from 'fastify'
import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'

import multipart from '@fastify/multipart'

import categoryRoutes from './routes/categories.js'
import tagRoutes from './routes/tags.js'
import timerRoutes from './routes/timer.js'
import todoRoutes from './routes/todos.js'
import statsRoutes from './routes/stats.js'
import goalRoutes from './routes/goals.js'
import memoRoutes, { UPLOAD_DIR } from './routes/memos.js'
import calendarRoutes from './routes/calendar.js'
import calendarsRoutes from './routes/calendars.js'
import { BODY_SIZE_LIMIT } from './config.js'
import { isSafeUploadPath } from './upload-path.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const app = Fastify({ logger: true, bodyLimit: BODY_SIZE_LIMIT })
const configuredOrigins = new Set(
  (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean),
)

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true
  if (configuredOrigins.has('*') || configuredOrigins.has(origin.replace(/\/$/, ''))) return true
  try {
    const url = new URL(origin)
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}

app.addHook('onSend', async (_req, reply, payload) => {
  reply.header('X-Content-Type-Options', 'nosniff')
  return payload
})

await app.register(cors, {
  origin: (origin, callback) => callback(null, isAllowedOrigin(origin)),
})
await app.register(multipart, {
  limits: {
    fileSize: 100 * 1024 * 1024, // 支持最高 100MB 视频/图片上传
  },
})

// 轻量存活检查：不访问数据库，避免健康检查本身放大数据库压力。
app.get('/healthz', async () => ({ ok: true }))

// 静态提供上传的媒体资源 (图片/视频)
await app.register(fastifyStatic, {
  root: UPLOAD_DIR,
  prefix: '/uploads/',
  allowedPath: (pathname, root) => isSafeUploadPath(pathname, root),
  decorateReply: false,
})

// API routes
await app.register(categoryRoutes, { prefix: '/api/categories' })
await app.register(tagRoutes, { prefix: '/api/tags' })
await app.register(timerRoutes, { prefix: '/api/timer' })
await app.register(todoRoutes, { prefix: '/api/todos' })
await app.register(statsRoutes, { prefix: '/api/stats' })
await app.register(goalRoutes, { prefix: '/api/goals' })
await app.register(memoRoutes, { prefix: '/api/memos' })
await app.register(calendarRoutes, { prefix: '/api/calendar' })
await app.register(calendarsRoutes, { prefix: '/api/calendars' })

// Serve built frontend (production)
const webDist = join(__dirname, '..', '..', 'web', 'dist')
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, wildcard: false })
  // SPA fallback
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api') || req.url.startsWith('/uploads')) {
      reply.code(404).send({ error: 'Not found' })
    } else {
      reply.sendFile('index.html')
    }
  })
}

const port = Number(process.env.PORT ?? 3000)
const host = process.env.HOST ?? '::'

try {
  const address = await app.listen({ port, host })
  app.log.info(`TagTime server listening on ${address}`)
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
