import type { Page, BrowserContext } from 'playwright'
import { clickDelay, typeDelay, randomDelay } from '../utils/timing'
import { decrypt } from '../utils/crypto'
import { childLogger } from '../utils/logger'
import type { Order } from '../types'

const log = childLogger('scanner:auth')

const DRIVETEST_URL = 'https://drivetest.ca/book-a-road-test/booking.html'
const DRIVETEST_LOGIN_URL = 'https://drivetest.ca/booking/booking-details.html'

export interface AuthResult {
  success: boolean
  error?: string
  needsEmailVerification?: boolean
}

/**
 * Authenticate on DriveTest.ca as the user.
 * Uses their own licence number + expiry — no credential spoofing.
 */
export async function authenticateDriveTest(
  page: Page,
  order: Order
): Promise<AuthResult> {
  const l = log.child({ order_id: order.id })

  try {
    l.info('Navigating to DriveTest booking page')
    await page.goto(DRIVETEST_URL, { waitUntil: 'networkidle', timeout: 30_000 })
    await randomDelay(800, 1500)

    // Fill email
    const email = await getOrderUserEmail(order.user_id)
    const emailField = page.locator('input[type="email"], input[name="email"], #email')
    await emailField.first().click()
    await clickDelay()

    for (const char of email) {
      await emailField.first().pressSequentially(char, { delay: 60 + Math.random() * 80 })
    }
    await randomDelay(300, 700)

    // Confirm email field (if present)
    const confirmEmail = page.locator('input[name="confirmEmail"], #confirmEmail')
    const confirmExists = await confirmEmail.count()
    if (confirmExists > 0) {
      await confirmEmail.first().click()
      await clickDelay()
      for (const char of email) {
        await confirmEmail.first().pressSequentially(char, { delay: 60 + Math.random() * 80 })
      }
    }

    // Fill licence number (decrypted in memory, never logged)
    const licenceNumber = decrypt(order.licence_number_enc)
    const licenceField = page.locator('input[name="licenceNumber"], #licNo, input[placeholder*="licence"]')
    await licenceField.first().click()
    await clickDelay()
    await licenceField.first().fill(licenceNumber)
    await typeDelay()

    // Fill expiry date
    const expiryField = page.locator('input[name="licenceExpiry"], #licExp, input[placeholder*="expiry"]')
    await expiryField.first().click()
    await clickDelay()
    await expiryField.first().fill(order.licence_expiry.replace(/-/g, '/'))
    await randomDelay(400, 800)

    // Submit
    const submitBtn = page.locator('button[type="submit"], input[type="submit"], .submit-btn')
    await submitBtn.first().click()
    await randomDelay(1500, 3000)

    // Check for email verification screen
    const verifyText = await page.locator('text=verify your email, text=verification email').count()
    if (verifyText > 0) {
      l.warn('Email verification required')
      return { success: false, needsEmailVerification: true }
    }

    // Check for "Hello" success screen
    const helloText = await page.locator('text=Hello, h1:has-text("Hello")').count()
    if (helloText > 0) {
      l.info('Authentication successful')
      return { success: true }
    }

    // Check for error messages
    const errorText = await page.locator('.error-message, .alert-danger, [role="alert"]').textContent()
    return { success: false, error: errorText ?? 'Unknown authentication error' }

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    l.error('Authentication failed', { error: message })
    return { success: false, error: message }
  }
}

/**
 * After login, click "Book a New Road Test" and select the test class.
 */
export async function navigateToTestSelection(
  page: Page,
  testClass: string
): Promise<boolean> {
  try {
    // Click Book a New Road Test
    await page.locator('text=Book a New Road Test, a:has-text("Book")').first().click()
    await randomDelay(1000, 2000)

    // Select test class
    const classOption = page.locator(`[value="${testClass}"], label:has-text("${testClass}")`)
    await classOption.first().click()
    await clickDelay()

    const continueBtn = page.locator('text=Continue, button:has-text("Continue")')
    await continueBtn.first().click()
    await randomDelay(1000, 2000)

    return true
  } catch {
    return false
  }
}

// Imported lazily to avoid circular dependency
async function getOrderUserEmail(userId: string): Promise<string> {
  const { users } = await import('../db/client')
  const user = await users.findById(userId)
  return user.email
}
