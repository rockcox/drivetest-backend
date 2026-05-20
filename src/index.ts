import 'dotenv/config'
import express from 'express'
import { config } from './config'
import { ordersRouter } from './api/orders'
import { statusRouter } from './api/status'
import { webhooksRouter } from './api/webhooks'
import { logger } from './utils/logger'

const app = express()

// ─── Stripe webhooks must receive raw body ────────────────────────────────────
app.use('/webhooks/stripe', express.raw({ type: 'application/json' }))

// ─── Standard middleware ──────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ extended: true }))

// Request logger
app.use((req, res, next) => {
  const start = Date.now()
  res.on('finish', () => {
    logger.info(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`)
  })
  next()
})

// CORS — allow your Next.js frontend
app.use((req, res, next) => {
  const origin = req.headers.origin
  const allowed = [config.app.url, 'http://localhost:3000']
  if (origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/orders', ordersRouter)
app.use('/status', statusRouter)
app.use('/webhooks', webhooksRouter)

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    env: config.app.env,
    timestamp: new Date().toISOString(),
  })
})

// Locations list (for frontend dropdown)
app.get('/locations', (_req, res) => {
  const { DRIVETEST_CENTRES } = require('./scanner/availability')
  res.json({ locations: DRIVETEST_CENTRES })
})

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' })
})

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack })
  res.status(500).json({ error: 'Internal server error' })
})

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(config.app.port, () => {
  logger.info(`API server running on port ${config.app.port} [${config.app.env}]`)
})

export default app
