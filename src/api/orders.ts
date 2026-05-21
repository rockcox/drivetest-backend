import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { users, orders, scanJobs, foundSlots, payments } from '../db/client'
import { getOrCreateCustomer, createSetupIntent, authorizePayment, cancelAuthorization } from '../services/payment'
import { sendEmail } from '../services/email'
import { enqueueScanJob, enqueueBookingJob, enqueueNotification, enqueueWeeklyUpdate } from '../queue/index'
import { encrypt } from '../utils/crypto'
import { childLogger } from '../utils/logger'
import { DRIVETEST_CENTRES } from '../scanner/availability'
import type { TestClass, TimePref } from '../types'

const log = childLogger('api:orders')
export const ordersRouter = Router()

// ─── Validation schemas ────────────────────────────────────────────────────────

const CreateOrderSchema = z.object({
  email: z.string().email(),
  phone: z.string().min(10).max(15),
  licenceNumber: z.string().min(6).max(20).regex(/^[A-Z0-9 -]*$/, 'Invalid licence format').transform(s => s.trim().toUpperCase()),
  licenceExpiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  testClass: z.enum(['G', 'G2', 'M', 'M2', 'A', 'AZ', 'B', 'C', 'D', 'F']),
  locations: z.array(z.string()).min(1).max(20),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timePref: z.enum(['any', 'morning', 'afternoon', 'weekdays', 'weekends']).default('any'),
  paymentMethodId: z.string().optional(),  // Provided after Stripe.js card entry
})

const ConfirmSlotSchema = z.object({
  foundSlotId: z.string().uuid(),
  paymentMethodId: z.string(),
})

// Helper to safely extract string param
function param(req: Request, key: string): string {
  return req.params[key] as string
}

// ─── POST /orders — Create a new search order ─────────────────────────────────

ordersRouter.post('/', async (req: Request, res: Response) => {
  const parse = CreateOrderSchema.safeParse(req.body)
  if (!parse.success) {
    return res.status(400).json({ error: 'Validation failed', details: parse.error.flatten() })
  }

  const input = parse.data
  const l = log.child({ email: input.email })

  try {
    // Validate all locations exist
    const invalidLocations = input.locations.filter(
      loc => !DRIVETEST_CENTRES.includes(loc as any)
    )
    if (invalidLocations.length > 0) {
      return res.status(400).json({ error: 'Invalid locations', invalid: invalidLocations })
    }

    // Validate date range
    const from = new Date(input.dateFrom)
    const to = new Date(input.dateTo)
    if (from >= to) return res.status(400).json({ error: 'dateFrom must be before dateTo' })
    if (from < new Date()) return res.status(400).json({ error: 'dateFrom must be in the future' })

    l.info('Creating order')

    // Upsert user
    const user = await users.upsert({ email: input.email, phone: input.phone })

    // Create or retrieve Stripe customer
    const stripeCustomerId = await getOrCreateCustomer(input.email, input.phone)
    await users.upsert({ ...user, stripe_customer_id: stripeCustomerId })

    // Determine service fee
    const feeCents = getServiceFee(input.testClass as TestClass)

    // Create order
    const order = await orders.create({
      user_id: user.id,
      licence_number_enc: encrypt(input.licenceNumber),
      licence_expiry: input.licenceExpiry,
      test_class: input.testClass as TestClass,
      locations: input.locations,
      date_from: input.dateFrom,
      date_to: input.dateTo,
      time_pref: input.timePref as TimePref,
      status: 'pending',
      service_fee_cents: feeCents,
      mto_fee_cents: 0,
    })

    // Create Stripe SetupIntent for card capture
    const { setupIntentId, clientSecret } = await createSetupIntent(stripeCustomerId)

    // Save payment record
    await payments.create({
      order_id: order.id,
      setup_intent_id: setupIntentId,
      amount_cents: feeCents,
      status: 'authorized',
    })

    // Create scan job (starts as 'waiting' — activated after card confirmed)
    const scanJob = await scanJobs.create({
      order_id: order.id,
      status: 'waiting',
      scan_count: 0,
      error_log: [],
    })

    l.info(`Order created: ${order.id}`)

    return res.status(201).json({
      orderId: order.id,
      scanJobId: scanJob.id,
      statusUrl: `${process.env.APP_URL}/order/${order.id}`,
      payment: {
        clientSecret,         // Pass to Stripe.js on frontend
        feeCents,
        feeFormatted: formatCents(feeCents),
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    l.error('Order creation failed', { error: message })
    return res.status(500).json({ error: 'Failed to create order' })
  }
})

// ─── POST /orders/:id/activate — Card saved, start scanning ──────────────────

ordersRouter.post('/:id/activate', async (req: Request, res: Response) => {
  const id = param(req, 'id')
  const { paymentMethodId } = req.body

  if (!paymentMethodId) {
    return res.status(400).json({ error: 'paymentMethodId required' })
  }

  try {
    const order = await orders.findById(id)
    if (order.status !== 'pending') {
      return res.status(409).json({ error: `Order is already ${order.status}` })
    }

    // Authorize (hold) the service fee — not captured yet
    const payment = await payments.findByOrderId(id)
    const user = await users.findById(order.user_id)
    const stripeCustomerId = user.stripe_customer_id!

    const { paymentIntentId } = await authorizePayment(
      stripeCustomerId,
      paymentMethodId,
      order.service_fee_cents,
      order.id
    )

    await payments.updateStatus(payment.id, 'authorized', { payment_intent_id: paymentIntentId })

    // Start scanning
    await orders.updateStatus(id, 'scanning')
    const scanJob = await scanJobs.findByOrderId(id)
    await scanJobs.update(scanJob.id, {
      status: 'active',
      next_scan_at: new Date().toISOString(),
    })

    // Enqueue first scan immediately
    await enqueueScanJob(id, scanJob.id)

    // Schedule weekly SMS updates
    await enqueueWeeklyUpdate(id, 7 * 24 * 60 * 60_000)

    // Send welcome email
    await sendEmail(user.email, {
      subject: 'Your DriveSlot search is now active',
      template: 'welcome',
      data: { statusUrl: `${process.env.APP_URL}/order/${id}` },
    })

    log.info(`Order ${id} activated — scanning started`)
    return res.json({ status: 'scanning', message: 'Search started successfully' })

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Activation failed', { order_id: id, error: message })
    return res.status(500).json({ error: 'Activation failed' })
  }
})

// ─── POST /orders/:id/confirm/:slotId — User confirms a found slot ────────────

ordersRouter.post('/:id/confirm/:slotId', async (req: Request, res: Response) => {
  const id = param(req, 'id'); const slotId = param(req, 'slotId')

  try {
    const [order, slot] = await Promise.all([
      orders.findById(id),
      foundSlots.findById(slotId),
    ])

    if (order.status !== 'slot_found') {
      return res.status(409).json({ error: `Order is ${order.status}, cannot confirm` })
    }

    if (slot.order_id !== id) {
      return res.status(403).json({ error: 'Slot does not belong to this order' })
    }

    if (slot.status !== 'pending') {
      return res.status(409).json({ error: `Slot is already ${slot.status}` })
    }

    if (new Date(slot.expires_at) < new Date()) {
      await foundSlots.updateStatus(slotId, 'expired')
      await orders.updateStatus(id, 'scanning')
      const scanJob = await scanJobs.findByOrderId(id)
      await scanJobs.update(scanJob.id, { status: 'active', next_scan_at: new Date().toISOString() })
      await enqueueScanJob(id, scanJob.id)
      return res.status(410).json({ error: 'Slot has expired. Resuming search.' })
    }

    // Enqueue high-priority booking job
    await enqueueBookingJob(id, slotId)

    log.info(`Slot confirmed by user: order=${id} slot=${slotId}`)
    return res.json({ status: 'confirming', message: 'Booking in progress — you\'ll be notified within 2 minutes' })

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Confirm failed', { order_id: id, error: message })
    return res.status(500).json({ error: 'Confirmation failed' })
  }
})

// ─── POST /orders/:id/reject-slot — User rejects a found slot ────────────────

ordersRouter.post('/:id/reject-slot', async (req: Request, res: Response) => {
  const id = param(req, 'id')
  const { slotId } = req.body

  try {
    const [order, slot] = await Promise.all([
      orders.findById(id),
      foundSlots.findById(slotId),
    ])

    if (slot.order_id !== id) {
      return res.status(403).json({ error: 'Slot does not belong to this order' })
    }

    await foundSlots.updateStatus(slotId, 'rejected')
    await orders.updateStatus(id, 'scanning')

    const scanJob = await scanJobs.findByOrderId(id)
    await scanJobs.update(scanJob.id, {
      status: 'active',
      next_scan_at: new Date().toISOString(),
    })
    await enqueueScanJob(id, scanJob.id)

    log.info(`Slot rejected, resuming search: order=${id}`)
    return res.json({ status: 'scanning', message: 'Search resumed' })

  } catch (err) {
    return res.status(500).json({ error: 'Failed to reject slot' })
  }
})

// ─── POST /orders/:id/cancel ───────────────────────────────────────────────────

ordersRouter.post('/:id/cancel', async (req: Request, res: Response) => {
  const id = param(req, 'id')

  try {
    const order = await orders.findById(id)

    if (['booked', 'cancelled'].includes(order.status)) {
      return res.status(409).json({ error: `Cannot cancel order with status: ${order.status}` })
    }

    // Cancel payment authorization (no charge)
    const payment = await payments.findByOrderId(id)
    if (payment.payment_intent_id && payment.status === 'authorized') {
      await cancelAuthorization(payment.payment_intent_id)
      await payments.updateStatus(payment.id, 'refunded')
    }

    // Pause scan job
    const scanJob = await scanJobs.findByOrderId(id)
    await scanJobs.update(scanJob.id, { status: 'completed' })

    await orders.updateStatus(id, 'cancelled')

    // Notify user
    await enqueueNotification({ order_id: id, type: 'cancelled' })

    log.info(`Order cancelled: ${id}`)
    return res.json({ status: 'cancelled', message: 'Order cancelled. No charge has been made.' })

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Cancel failed', { order_id: id, error: message })
    return res.status(500).json({ error: 'Cancellation failed' })
  }
})

// ─── PATCH /orders/:id — Update preferences mid-search ───────────────────────

ordersRouter.patch('/:id', async (req: Request, res: Response) => {
  const id = param(req, 'id')
  const UpdateSchema = z.object({
    locations: z.array(z.string()).min(1).max(20).optional(),
    dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    timePref: z.enum(['any', 'morning', 'afternoon', 'weekdays', 'weekends']).optional(),
  })

  const parse = UpdateSchema.safeParse(req.body)
  if (!parse.success) return res.status(400).json({ error: 'Validation failed' })

  try {
    const order = await orders.findById(id)
    if (!['scanning', 'slot_found'].includes(order.status)) {
      return res.status(409).json({ error: 'Can only update active orders' })
    }

    const updates: Record<string, unknown> = {}
    if (parse.data.locations) updates.locations = parse.data.locations
    if (parse.data.dateTo) updates.date_to = parse.data.dateTo
    if (parse.data.timePref) updates.time_pref = parse.data.timePref

    const { db } = await import('../db/client')
    await db.from('orders').update(updates).eq('id', id)

    return res.json({ message: 'Preferences updated' })
  } catch (err) {
    return res.status(500).json({ error: 'Update failed' })
  }
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getServiceFee(testClass: TestClass): number {
  const fees: Record<TestClass, number> = {
    G2: 4900, G: 5900, M2: 4900, M: 5900,
    A: 7900, AZ: 7900, B: 7900, C: 7900, D: 7900, F: 7900,
  }
  return fees[testClass] ?? 5900
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}
