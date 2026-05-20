import { Worker } from 'bullmq'
import { chromium } from 'playwright'
import { addExtra } from 'playwright-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { connection, enqueueNotification } from './index'
import { orders, foundSlots, bookings, payments, scanJobs } from '../db/client'
import { authenticateDriveTest, navigateToTestSelection } from '../scanner/auth'
import { completeBooking } from '../scanner/booking'
import { capturePayment } from '../services/payment'
import { config } from '../config'
import { childLogger } from '../utils/logger'
import type { BookingJobPayload } from '../types'

const log = childLogger('worker:booking')
const chromiumWithStealth = addExtra(chromium as any)
chromiumWithStealth.use(StealthPlugin())

export function createBookingWorker() {
  const worker = new Worker<BookingJobPayload>(
    'booking',
    async (job) => {
      const { order_id, found_slot_id } = job.data
      const l = log.child({ order_id, found_slot_id })
      l.info('Processing booking confirmation')

      const [order, slot] = await Promise.all([
        orders.findById(order_id),
        foundSlots.findById(found_slot_id),
      ])

      // Check slot hasn't expired
      if (slot.status !== 'pending' || new Date(slot.expires_at) < new Date()) {
        l.warn('Slot expired before booking could complete')
        await orders.updateStatus(order_id, 'scanning')
        const sj = await scanJobs.findByOrderId(order_id)
        await scanJobs.update(sj.id, { status: 'active' })
        return { success: false, reason: 'slot_expired' }
      }

      await orders.updateStatus(order_id, 'confirming')

      // Launch browser for booking
      const proxyConfig = config.proxy.enabled ? {
        server: `http://${config.proxy.host}:${config.proxy.port}`,
        username: config.proxy.user,
        password: config.proxy.pass,
      } : undefined

      const browser = await chromiumWithStealth.launch({ headless: true, proxy: proxyConfig })
      const context = await browser.newContext({
        viewport: { width: 1366, height: 768 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        locale: 'en-CA',
        timezoneId: 'America/Toronto',
      })
      const page = await context.newPage()

      try {
        // Re-authenticate
        const authResult = await authenticateDriveTest(page, order)
        if (!authResult.success) throw new Error(`Auth failed: ${authResult.error}`)

        await navigateToTestSelection(page, order.test_class)

        // Navigate to the specific location and slot
        // (In production, you'd navigate directly to the found slot's location+date)
        const payment = await payments.findByOrderId(order_id)

        // Get payment method details from Stripe
        const { getPaymentMethodDetails } = await import('../services/payment')
        const paymentDetails = await getPaymentMethodDetails(payment.setup_intent_id!)

        // Complete the booking
        const result = await completeBooking(page, {
          location: slot.location,
          date: slot.test_date,
          time: slot.test_time,
          centre_id: slot.location.toLowerCase().replace(/\s+/g, '-'),
        }, paymentDetails)

        if (!result.success) throw new Error(result.error ?? 'Booking failed')

        // Save booking record
        const booking = await bookings.create({
          order_id,
          found_slot_id,
          drivetest_confirmation: result.confirmationNumber!,
          location: slot.location,
          test_date: slot.test_date,
          test_time: slot.test_time,
        })

        // Capture Stripe payment
        await capturePayment(payment.id, order.service_fee_cents)

        // Update statuses
        await Promise.all([
          orders.updateStatus(order_id, 'booked'),
          foundSlots.updateStatus(found_slot_id, 'confirmed'),
          payments.updateStatus(payment.id, 'captured', { captured_at: new Date().toISOString() }),
        ])

        // Send confirmation notifications
        await enqueueNotification({
          order_id,
          type: 'booked',
          booking,
        })

        l.info(`Booking complete: ${result.confirmationNumber}`)
        return { success: true, confirmation: result.confirmationNumber }

      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        l.error('Booking failed', { error: message })

        await orders.updateStatus(order_id, 'failed')
        await foundSlots.updateStatus(found_slot_id, 'rejected')

        await enqueueNotification({ order_id, type: 'failed' })
        throw err

      } finally {
        await page.close().catch(() => null)
        await context.close().catch(() => null)
        await browser.close().catch(() => null)
      }
    },
    {
      connection,
      concurrency: 3,  // Keep booking concurrency low — each needs full browser
    }
  )

  worker.on('completed', (job, result) => {
    log.info(`Booking job completed`, { job_id: job.id, ...result })
  })

  worker.on('failed', (job, err) => {
    log.error(`Booking job failed`, { job_id: job?.id, error: err.message })
  })

  log.info('Booking worker started')
  return worker
}
