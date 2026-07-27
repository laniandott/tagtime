import Fastify from 'fastify'
import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'

import categoryRoutes from './routes/categories.js'
import tagRoutes from './routes/tags.js'
import timerRoutes from './routes/timer.js'
import todoRoutes from './routes/todos.js'
import statsRoutes from './routes/stats.js'
import goalRoutes from './routes/goals.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const app = Fastify({ logger: true })

await app.register(cors, { origin: true })

// API routes
await app.register(categoryRoutes, { prefix: '/api/categories' })
await app.register(tagRoutes, { prefix: '/api/tags' })
await app.register(timerRoutes, { prefix: '/api/timer' })
await app.register(todoRoutes, { prefix: '/api/todos' })
await app.register(statsRoutes, { prefix: '/api/stats' })
await app.register(goalRoutes, { prefix: '/api/goals' })

// Serve built frontend (production)
const webDist = join(__dirname, '..', '..', 'web', 'dist')
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, wildcard: false })
  // SPA fallback
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api')) {
      reply.code(404).send({ error: 'Not found' })
    } else {
      reply.sendFile('index.html')
    }
  })
}

const host = process.env.HOST ?? '0.0.0.0'
const port = Number(process.env.PORT ?? 3000)

app.listen({ host: '0.0.0.0', port }, (err, address) => {
  if (err) {
    app.log.error(err)
    process.exit(1)
  }
  app.log.info(`TagTime server listening on ${address}`)
})
