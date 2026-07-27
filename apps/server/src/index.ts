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

const __dirname = dirname(fileURLToPath(import.meta.url))

const app = Fastify({ logger: true })

await app.register(cors, { origin: true })
await app.register(multipart, {
  limits: {
    fileSize: 100 * 1024 * 1024, // 支持最高 100MB 视频/图片上传
  },
})

// 静态提供上传的媒体资源 (图片/视频)
await app.register(fastifyStatic, {
  root: UPLOAD_DIR,
  prefix: '/uploads/',
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

try {
  const address = await app.listen({ port, host: '0.0.0.0' })
  app.log.info(`TagTime server listening on ${address}`)
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
