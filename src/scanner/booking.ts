import type { Page } from 'playwright'
import { clickDelay, randomDelay } from '../utils/timing'
import { solveCaptcha } from '../services/captcha'
import { childLogger } from '../utils/logger'
import type { AvailableSlot } from '../types'

const log = childLogger('scanner:booking')

export interface BookingResult {
  success: boolean
  confirmationNumber?: string
  error?: string
}

/**
 * Complete the DriveTest.ca booking flow for a found slot.
 * Handles CAPTCHA, payment confirmation, and returns the confirmation number.
 */
export async function completeBooking(
  page: Page,
  slot: AvailableSlot,
  paymentDetails: {
    cardNumber: string
    expiry: string
    cvv: string
    nameOnCard: string
    billingAddress: string
    billingCity: string
    billingPostal: string
    billingPhone: string
  }
): Promise<BookingResult> {
  const l = log.child({ location: slot.location, date: slot.date, time: slot.time })

  try {
    // Click the specific time slot
    const timeBtn = page.locator(
      `[data-time="${slot.time}"], .time-slot:has-text("${slot.time}"), input[value="${slot.time}"]`
    )
    await timeBtn.first().click()
    await clickDelay()

    // Click Continue to payment
    const continueBtn = page.locator('text=Continue, button:has-text("Continue")')
    await continueBtn.first().click()
    await randomDelay(1500, 2500)

    // Fill payment form
    l.info('Filling payment details')
    await fillPaymentForm(page, paymentDetails)
    await randomDelay(800, 1500)

    // Agree to terms
    const termsCheckbox = page.locator('input[type="checkbox"][name*="terms"], #agreeTerms')
    if (await termsCheckbox.count() > 0) {
      await termsCheckbox.first().check()
      await clickDelay()
    }

    // Solve CAPTCHA before final submit
    l.info('Solving CAPTCHA')
    const captchaSiteKey = await extractCaptchaSiteKey(page)
    if (captchaSiteKey) {
      const token = await solveCaptcha(captchaSiteKey, page.url())
      await injectCaptchaToken(page, token)
      await randomDelay(500, 1000)
    }

    // Submit payment
    const submitBtn = page.locator(
      'button:has-text("Submit"), input[type="submit"], #submitPayment, .confirm-booking'
    )
    await submitBtn.first().click()
    await randomDelay(3000, 5000)

    // Extract confirmation number
    const confirmationEl = page.locator(
      '#confirmation-number, .confirmation-number, [class*="confirmation"]'
    )
    if (await confirmationEl.count() > 0) {
      const confirmNum = await confirmationEl.first().textContent()
      const cleaned = confirmNum?.replace(/[^A-Z0-9-]/gi, '').trim()
      if (cleaned) {
        l.info(`Booking confirmed: ${cleaned}`)
        return { success: true, confirmationNumber: cleaned }
      }
    }

    // Check for success message
    const successText = await page.locator('text=Your road test is booked').count()
    if (successText > 0) {
      const conf = await extractConfirmationFromPage(page)
      return { success: true, confirmationNumber: conf ?? 'CONFIRMED' }
    }

    // Check for errors
    const errorText = await page.locator('.error, .alert-danger, [role="alert"]').textContent()
    return { success: false, error: errorText ?? 'Booking failed — no confirmation found' }

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    l.error('Booking completion failed', { error: message })
    return { success: false, error: message }
  }
}

async function fillPaymentForm(
  page: Page,
  details: {
    cardNumber: string; expiry: string; cvv: string; nameOnCard: string
    billingAddress: string; billingCity: string; billingPostal: string; billingPhone: string
  }
) {
  // DriveTest uses TD Payment Solution — fields may be in iframes
  const cardFrame = page.frameLocator('iframe[name*="payment"], iframe[src*="payment"]')

  const fillField = async (selector: string, value: string, inFrame = false) => {
    const el = inFrame ? cardFrame.locator(selector) : page.locator(selector)
    if (await el.count() > 0) {
      await el.first().click()
      await el.first().fill(value)
      await randomDelay(200, 600)
    }
  }

  await fillField('input[name="cardType"], #cardType, select[name="cardType"]', 'VISA')
  await fillField('input[name="cardNumber"], #cardNumber', details.cardNumber, true)
  await fillField('input[name="cardExpiry"], #expiryDate', details.expiry, true)
  await fillField('input[name="cvv"], #cvv, input[name="CVV"]', details.cvv, true)
  await fillField('input[name="nameOnCard"], #nameOnCard', details.nameOnCard)
  await fillField('input[name="phone"], #phone', details.billingPhone)
  await fillField('input[name="address"], #address', details.billingAddress)
  await fillField('input[name="city"], #city', details.billingCity)
  await fillField('input[name="postalCode"], #postalCode', details.billingPostal)
}

async function extractCaptchaSiteKey(page: Page): Promise<string | null> {
  const siteKey = await page.evaluate(() => {
    const recaptcha = document.querySelector('.g-recaptcha')
    return recaptcha?.getAttribute('data-sitekey') ?? null
  })
  return siteKey
}

async function injectCaptchaToken(page: Page, token: string): Promise<void> {
  await page.evaluate((t) => {
    const textarea = document.querySelector('#g-recaptcha-response') as HTMLTextAreaElement
    if (textarea) {
      textarea.style.display = 'block'
      textarea.value = t
    }
    // Trigger callback if defined
    const cb = (window as any).___grecaptcha_cfg?.clients?.[0]?.U?.U?.callback
    if (typeof cb === 'function') cb(t)
  }, token)
}

async function extractConfirmationFromPage(page: Page): Promise<string | null> {
  const text = await page.textContent('body')
  const match = text?.match(/confirmation.*?([A-Z0-9-]{6,20})/i)
  return match?.[1] ?? null
}
