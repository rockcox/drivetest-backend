import dotenv from 'dotenv'
dotenv.config()

function required(key: string): string {
  const val = process.env[key]
  if (!val) throw new Error(`Missing required env var: ${key}`)
  return val
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback
}

export const config = {
  app: {
    port: parseInt(optional('PORT', '3001')),
    env: optional('NODE_ENV', 'development'),
    url: optional('APP_URL', 'http://localhost:3000'),
    isDev: optional('NODE_ENV', 'development') === 'development',
  },

  supabase: {
    url: required('SUPABASE_URL'),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  },

  redis: {
    url: optional('REDIS_URL', 'redis://localhost:6379'),
  },

  stripe: {
    secretKey: required('STRIPE_SECRET_KEY'),
    webhookSecret: required('STRIPE_WEBHOOK_SECRET'),
  },

  twilio: {
    accountSid: required('TWILIO_ACCOUNT_SID'),
    authToken: required('TWILIO_AUTH_TOKEN'),
    phoneNumber: required('TWILIO_PHONE_NUMBER'),
  },

  resend: {
    apiKey: required('RESEND_API_KEY'),
    from: optional('EMAIL_FROM', 'noreply@yourdomain.ca'),
  },

  captcha: {
    apiKey: required('CAPTCHA_API_KEY'),
    solveTimeoutMs: 60_000,
  },

  proxy: {
    host: optional('PROXY_HOST', ''),
    port: parseInt(optional('PROXY_PORT', '22225')),
    user: optional('PROXY_USER', ''),
    pass: optional('PROXY_PASS', ''),
    enabled: !!process.env.PROXY_HOST,
  },

  encryption: {
    key: required('ENCRYPTION_KEY'), // 32 char hex
  },

  worker: {
    maxConcurrentSessions: parseInt(optional('MAX_CONCURRENT_SESSIONS', '20')),
    scanIntervalMinMinutes: parseInt(optional('SCAN_INTERVAL_MIN_MINUTES', '4')),
    scanIntervalMaxMinutes: parseInt(optional('SCAN_INTERVAL_MAX_MINUTES', '8')),
    slotHoldHours: parseInt(optional('SLOT_HOLD_HOURS', '2')),
  },
} as const
