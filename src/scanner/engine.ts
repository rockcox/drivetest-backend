import { chromium } from 'playwright'
import { addExtra } from 'playwright-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { authenticateDriveTest, navigateToTestSelection } from './auth'
import { scanLocations } from './availability'
import { config } from '../config'
import { childLogger } from '../utils/logger'
import { nextScanIntervalMs, randomDelay } from '../utils/timing'
import { orders, scanJobs, foundSlots, notificationLog } from '../db/client'
import { sendSlotFoundSMS } from '../services/sms'
import { sendSlotFoundEmail } from '../services/email'
import { db } from '../db/client'
import { addMilliseconds } from 'date-fns'
import type { Order, ScanJob, AvailableSlot } from '../types'

const log = childLogger('scanner:engine')

// Playwright with stealth plugin
const chromiumWithStealth = addExtra(chromium as any)
chromiumWithStealth.use(StealthPlugin())

/**
 * Run a single scan pass for an order.
 * Called by the scan worker whenever a job becomes due.
 */
export async function runScanPass(
  order: Order,
  job: ScanJob
): Promise<{ found: boolean; slot?: AvailableSlot; error?: string }> {
  const l = log.child({ order_id: order.id, job_id: job.id })
  l.info('Starting scan pass')

  const proxyConfig = config.proxy.enabled ? {
    server: `http://${config.proxy.host}:${config.proxy.port}`,
    username: config.proxy.user,
    password: config.proxy.pass,
  } : undefined

  const browser = await chromiumWithStealth.launch({
    headless: true,
    proxy: proxyConfig,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  })

  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'en-CA',
    timezoneId: 'America/Toronto',
  })

  const page = await context.newPage()
  page.setDefaultTimeout(20_000)

  try {
    // Authenticate
    const authResult = await authenticateDriveTest(page, order)

    if (!authResult.success) {
      if (authResult.needsEmailVerification) {
        l.warn('Email verification required — cannot proceed')
        await scanJobs.appendError(job.id, {
          timestamp: new Date().toISOString(),
          type: 'auth',
          message: 'Email verification required for this account',
        })
        await scheduleNextScan(job.id)
        return { found: false, error: 'email_verification_required' }
      }
      throw new Error(authResult.error ?? 'Auth failed')
    }

    // Navigate to test type selection
    const navigated = await navigateToTestSelection(page, order.test_class)
    if (!navigated) throw new Error('Failed to navigate to test selection')

    // Scan all preferred locations
    const slot = await scanLocations(page, order)

    // Update scan stats
    await scanJobs.update(job.id, {
      last_scan_at: new Date().toISOString(),
      scan_count: job.scan_count + 1,
      current_location: undefined,
    })

    if (slot) {
      // Slot found — save it, notify user, pause scanner
      await handleSlotFound(order, job, slot)
      return { found: true, slot }
    }

    // No slot — schedule next scan
    await scheduleNextScan(job.id)
    l.info('Pass complete, no slot. Next scan scheduled.')
    return { found: false }

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    l.error('Scan pass error', { error: message })

    const errorType = classifyError(message)
    await scanJobs.appendError(job.id, {
      timestamp: new Date().toISOString(),
      type: errorType,
      message,
    })

    // Back off on errors
    const backoffMs = computeBackoff(job.error_log.length)
    await scanJobs.update(job.id, {
      next_scan_at: addMilliseconds(new Date(), backoffMs).toISOString(),
    })

    return { found: false, error: message }

  } finally {
    await page.close().catch(() => null)
    await context.close().catch(() => null)
    await browser.close().catch(() => null)
  }
}

async function handleSlotFound(
  order: Order,
  job: ScanJob,
  slot: AvailableSlot
): Promise<void> {
  const l = log.child({ order_id: order.id })

  // Save found slot
  const holdExpiry = addMilliseconds(new Date(), config.worker.slotHoldHours * 3_600_000)
  const savedSlot = await foundSlots.create({
    order_id: order.id,
    location: slot.location,
    test_date: slot.date,
    test_time: slot.time,
    status: 'pending',
    expires_at: holdExpiry.toISOString(),
  })

  // Update order and job status
  await orders.updateStatus(order.id, 'slot_found')
  await scanJobs.update(job.id, { status: 'paused' })

  // Get user for notifications
  const { users } = await import('../db/client')
  const user = await users.findById(order.user_id)

  // Fire all notifications in parallel
  l.info('Firing notifications', { slot })
  await Promise.allSettled([
    sendSlotFoundSMS(user.phone, { ...slot, order_id: order.id, slot_id: savedSlot.id }),
    sendSlotFoundEmail(user.email, { ...slot, order_id: order.id, slot_id: savedSlot.id }),
    // Push realtime update to dashboard
    db.channel(`order:${order.id}`).send({
      type: 'broadcast',
      event: 'slot_found',
      payload: { slot: savedSlot },
    }),
  ])

  // Log notifications
  await notificationLog.record({ order_id: order.id, type: 'slot_found', channel: 'sms', success: true })
  await notificationLog.record({ order_id: order.id, type: 'slot_found', channel: 'email', success: true })
}

async function scheduleNextScan(jobId: string): Promise<void> {
  const intervalMs = nextScanIntervalMs(
    config.worker.scanIntervalMinMinutes,
    config.worker.scanIntervalMaxMinutes
  )
  await scanJobs.update(jobId, {
    next_scan_at: addMilliseconds(new Date(), intervalMs).toISOString(),
    status: 'active',
  })
}

function classifyError(message: string): ScanJob['error_log'][0]['type'] {
  if (message.includes('rate') || message.includes('429')) return 'rate_limit'
  if (message.includes('captcha')) return 'captcha'
  if (message.includes('network') || message.includes('timeout')) return 'network'
  if (message.includes('auth') || message.includes('login')) return 'auth'
  return 'unknown'
}

function computeBackoff(errorCount: number): number {
  // 10 min, 30 min, 60 min, then cap at 2h
  const minutes = Math.min(120, 10 * Math.pow(2, Math.min(errorCount, 3)))
  return minutes * 60_000
}
