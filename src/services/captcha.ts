import axios from 'axios'
import { config } from '../config'
import { childLogger } from '../utils/logger'

const log = childLogger('service:captcha')
const BASE = 'https://2captcha.com'

function isRealKey(): boolean {
  const key = config.captcha.apiKey
  return Boolean(key && !key.includes('placeholder') && key !== 'xxx' && key.length > 10)
}

/**
 * Solve a reCAPTCHA v2 challenge via 2captcha.
 * If no API key is configured, returns a dummy token so the booking worker
 * can still run in test mode (the booking will fail at DriveTest.ca, but
 * all the surrounding logic — DB writes, notifications, charge — will be tested).
 */
export async function solveCaptcha(siteKey: string, pageUrl: string): Promise<string> {
  if (!isRealKey()) {
    log.warn('CAPTCHA skipped — no 2captcha key configured. Returning dummy token for test mode.')
    log.warn('Add a real CAPTCHA_API_KEY (~$3 at 2captcha.com) to complete actual bookings.')
    return 'test-mode-dummy-captcha-token'
  }

  log.info('Submitting CAPTCHA for solving', { pageUrl })

  const submitRes = await axios.post(`${BASE}/in.php`, null, {
    params: {
      key: config.captcha.apiKey,
      method: 'userrecaptcha',
      googlekey: siteKey,
      pageurl: pageUrl,
      json: 1,
    },
    timeout: 10_000,
  })

  if (submitRes.data.status !== 1) {
    throw new Error(`CAPTCHA submit failed: ${submitRes.data.request}`)
  }

  const taskId = submitRes.data.request
  log.debug(`CAPTCHA task submitted: ${taskId}`)

  const deadline = Date.now() + config.captcha.solveTimeoutMs
  while (Date.now() < deadline) {
    await sleep(5_000)
    const pollRes = await axios.get(`${BASE}/res.php`, {
      params: { key: config.captcha.apiKey, action: 'get', id: taskId, json: 1 },
      timeout: 10_000,
    })
    if (pollRes.data.status === 1) {
      log.info('CAPTCHA solved successfully')
      return pollRes.data.request as string
    }
    if (pollRes.data.request !== 'CAPCHA_NOT_READY') {
      throw new Error(`CAPTCHA solving failed: ${pollRes.data.request}`)
    }
  }

  throw new Error('CAPTCHA solve timeout exceeded')
}

export async function reportBadCaptcha(taskId: string): Promise<void> {
  if (!isRealKey()) return
  await axios.get(`${BASE}/res.php`, {
    params: { key: config.captcha.apiKey, action: 'reportbad', id: taskId, json: 1 },
  }).catch(() => null)
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
