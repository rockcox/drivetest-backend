import { childLogger } from '../utils/logger'

const log = childLogger('service:captcha')

/**
 * Attempt to handle a reCAPTCHA challenge.
 *
 * With a well-configured stealth browser (playwright-extra + stealth plugin,
 * realistic UA/locale/timezone), DriveTest.ca typically does NOT present a CAPTCHA.
 * This function is called only if a .g-recaptcha element is detected on the page.
 *
 * Current strategy: log a warning and return null so the booking attempt
 * proceeds without a token. Many reCAPTCHA v2 implementations accept a submit
 * without a token if the site's risk score is low (invisible reCAPTCHA behaviour).
 *
 * If we confirm CAPTCHA blocks bookings in production, we'll add a solving
 * service here. Cost: ~$0.003/solve at 2captcha.com.
 */
export async function solveCaptcha(siteKey: string, pageUrl: string): Promise<string | null> {
  log.warn('reCAPTCHA element detected on page — attempting to proceed without token', { pageUrl })
  log.warn('If bookings consistently fail here, add CAPTCHA_API_KEY from 2captcha.com (~$3)')
  return null  // returning null = skip token injection, attempt submit anyway
}

export async function reportBadCaptcha(_taskId: string): Promise<void> {
  // no-op
}
