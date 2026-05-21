import 'dotenv/config'
import express from 'express'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import hpp from 'hpp'
import { config } from './config'
import { ordersRouter } from './api/orders'
import { statusRouter } from './api/status'
import { webhooksRouter } from './api/webhooks'
import { logger } from './utils/logger'

const app = express()

// ─── Security headers (helmet) ────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}))

// ─── Rate limiting ─────────────────────────────────────────────────────────────
// Global: 200 req/15min per IP
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
}))

// Tight limit on order creation: 5 orders per hour per IP
const orderCreationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Order creation limit reached. Please wait before creating another search.' },
  skip: (req) => req.method !== 'POST',
})

// ─── HTTP Parameter Pollution protection ──────────────────────────────────────
app.use(hpp())

// ─── Stripe webhooks must receive raw body ────────────────────────────────────
app.use('/webhooks/stripe', express.raw({ type: 'application/json' }))

// ─── Standard middleware ──────────────────────────────────────────────────────
app.use(express.json({ limit: '100kb' }))     // Prevent large payload attacks
app.use(express.urlencoded({ extended: false, limit: '100kb' }))

// ─── Request logger ───────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now()
  res.on('finish', () => {
    if (res.statusCode >= 400) {
      logger.warn(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`, {
        ip: req.ip,
        ua: req.headers['user-agent']?.substring(0, 80),
      })
    } else {
      logger.info(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`)
    }
  })
  next()
})

// ─── CORS — tight allowlist ───────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  config.app.url,
  'http://localhost:3000',
  'https://drivetest-frontend.vercel.app',
].filter(Boolean)

app.use((req, res, next) => {
  const origin = req.headers.origin
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Vary', 'Origin')
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/orders', orderCreationLimiter, ordersRouter)
app.use('/status', statusRouter)
app.use('/webhooks', webhooksRouter)

// Health check — no auth needed, no sensitive info
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', env: config.app.env, ts: new Date().toISOString() })
})

// Locations list
app.get('/locations', (_req, res) => {
  const { DRIVETEST_CENTRES } = require('./scanner/availability')
  res.json({ locations: DRIVETEST_CENTRES })
})

// 404
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' })
})

// Global error handler — never leak stack traces to clients
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack })
  res.status(500).json({ error: 'Internal server error' })
})

app.listen(config.app.port, () => {
  logger.info(`API server on port ${config.app.port} [${config.app.env}]`)
})

export default app
