import axios from 'axios'
import { config } from '../config'
import { childLogger } from '../utils/logger'

const log = childLogger('service:captcha')
const BASE = 'https://2captcha.com'

/**
 * Submit a reCAPTCHA v2 challenge and poll until solved.
 * Typical solve time: 5–30 seconds. Cost: ~$0.003 per solve.
 */
export async function solveCaptcha(siteKey: string, pageUrl: string): Promise<string> {
  log.info('Submitting CAPTCHA for solving', { pageUrl })

  // Submit task
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

  // Poll for result
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

/**
 * Report a bad CAPTCHA token (get credit back from 2captcha).
 */
export async function reportBadCaptcha(taskId: string): Promise<void> {
  await axios.get(`${BASE}/res.php`, {
    params: { key: config.captcha.apiKey, action: 'reportbad', id: taskId, json: 1 },
  }).catch(() => null)
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
