import { Router, Request, Response } from 'express'
import { db, orders, scanJobs, foundSlots } from '../db/client'
import { childLogger } from '../utils/logger'

const log = childLogger('api:status')
export const statusRouter = Router()

// ─── GET /status/:orderId — Full order status for dashboard ───────────────────

statusRouter.get('/:orderId', async (req: Request, res: Response) => {
  const { orderId } = req.params

  try {
    const { data: order, error: orderErr } = await db
      .from('orders')
      .select(`
        id, status, test_class, locations, date_from, date_to,
        time_pref, service_fee_cents, created_at, updated_at,
        users!inner(email, phone)
      `)
      .eq('id', orderId)
      .single()

    if (orderErr || !order) {
      return res.status(404).json({ error: 'Order not found' })
    }

    // Fetch scan job
    const { data: scanJob } = await db
      .from('scan_jobs')
      .select('*')
      .eq('order_id', orderId)
      .maybeSingle()

    // Fetch pending slot (if any)
    const { data: slot } = await db
      .from('found_slots')
      .select('*')
      .eq('order_id', orderId)
      .eq('status', 'pending')
      .maybeSingle()

    // Fetch confirmed booking (if any)
    const { data: booking } = await db
      .from('bookings')
      .select('*')
      .eq('order_id', orderId)
      .maybeSingle()

    // Fetch recent notifications
    const { data: notifications } = await db
      .from('notification_log')
      .select('type, channel, sent_at, success')
      .eq('order_id', orderId)
      .order('sent_at', { ascending: false })
      .limit(10)

    return res.json({
      order: {
        id: order.id,
        status: order.status,
        testClass: order.test_class,
        locations: order.locations,
        dateFrom: order.date_from,
        dateTo: order.date_to,
        timePref: order.time_pref,
        serviceFee: `$${(order.service_fee_cents / 100).toFixed(2)}`,
        createdAt: order.created_at,
      },
      scanner: scanJob ? {
        status: scanJob.status,
        scanCount: scanJob.scan_count,
        lastScanAt: scanJob.last_scan_at,
        nextScanAt: scanJob.next_scan_at,
        currentLocation: scanJob.current_location,
        recentErrors: (scanJob.error_log as any[]).slice(-3),
      } : null,
      foundSlot: slot ? {
        id: slot.id,
        location: slot.location,
        date: slot.test_date,
        time: slot.test_time,
        expiresAt: slot.expires_at,
        expiresInMinutes: Math.max(0, Math.round(
          (new Date(slot.expires_at).getTime() - Date.now()) / 60_000
        )),
      } : null,
      booking: booking ? {
        confirmation: booking.drivetest_confirmation,
        location: booking.location,
        date: booking.test_date,
        time: booking.test_time,
        bookedAt: booking.booked_at,
      } : null,
      notifications: notifications ?? [],
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Status fetch failed', { order_id: orderId, error: message })
    return res.status(500).json({ error: 'Failed to fetch status' })
  }
})

// ─── GET /status/:orderId/scan-log — Detailed scan history ───────────────────

statusRouter.get('/:orderId/scan-log', async (req: Request, res: Response) => {
  const { orderId } = req.params
  const limit = Math.min(parseInt(req.query.limit as string ?? '50'), 100)

  try {
    const { data: scanJob } = await db
      .from('scan_jobs')
      .select('scan_count, last_scan_at, error_log, status')
      .eq('order_id', orderId)
      .single()

    if (!scanJob) return res.status(404).json({ error: 'Scan job not found' })

    return res.json({
      totalScans: scanJob.scan_count,
      lastScan: scanJob.last_scan_at,
      jobStatus: scanJob.status,
      errors: (scanJob.error_log as any[]).slice(-limit),
    })
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch scan log' })
  }
})

// ─── GET /status/admin/overview — Internal ops dashboard ─────────────────────

statusRouter.get('/admin/overview', async (req: Request, res: Response) => {
  // TODO: Add admin auth middleware
  try {
    const [
      { count: activeOrders },
      { count: pendingSlots },
      { count: completedToday },
      { data: errorJobs },
    ] = await Promise.all([
      db.from('orders').select('*', { count: 'exact', head: true }).eq('status', 'scanning'),
      db.from('found_slots').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      db.from('bookings').select('*', { count: 'exact', head: true })
        .gte('booked_at', new Date(Date.now() - 86_400_000).toISOString()),
      db.from('scan_jobs').select('order_id, error_log')
        .eq('status', 'active')
        .order('updated_at', { ascending: false })
        .limit(5),
    ])

    return res.json({
      activeOrders,
      pendingSlots,
      completedToday,
      recentErrorJobs: errorJobs,
      timestamp: new Date().toISOString(),
    })
  } catch (err) {
    return res.status(500).json({ error: 'Admin overview failed' })
  }
})
