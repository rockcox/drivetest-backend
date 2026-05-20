import { Queue, QueueEvents } from 'bullmq'
import IORedis from 'ioredis'
import { config } from '../config'
import type { ScanJobPayload, BookingJobPayload, NotifyJobPayload } from '../types'

// Shared Redis connection — maxRetriesPerRequest: null required by BullMQ
export const connection = new IORedis(config.redis.url, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
})

const baseOpts = { connection }

// ─── Queue definitions ────────────────────────────────────────────────────────

export const scanQueue = new Queue<ScanJobPayload>('scan', {
  connection,
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 200,
    attempts: 3,
    backoff: { type: 'exponential', delay: 30_000 },
  },
})

export const bookingQueue = new Queue<BookingJobPayload>('booking', {
  connection,
  defaultJobOptions: {
    removeOnComplete: 200,
    removeOnFail: 500,
    attempts: 2,
    backoff: { type: 'fixed', delay: 60_000 },
    priority: 1,
  },
})

export const notifyQueue = new Queue<NotifyJobPayload>('notify', {
  connection,
  defaultJobOptions: {
    removeOnComplete: 500,
    removeOnFail: 200,
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
  },
})

export const cleanupQueue = new Queue('cleanup', {
  connection,
  defaultJobOptions: { removeOnComplete: 10, removeOnFail: 50 },
})

// ─── Convenience: enqueue helpers ─────────────────────────────────────────────

export async function enqueueScanJob(
  orderId: string,
  scanJobId: string,
  delayMs = 0
) {
  return scanQueue.add(
    'scan',
    { order_id: orderId, scan_job_id: scanJobId },
    { delay: delayMs, jobId: `scan:${orderId}` }
  )
}

export async function enqueueBookingJob(orderId: string, foundSlotId: string) {
  return bookingQueue.add(
    'booking',
    { order_id: orderId, found_slot_id: foundSlotId },
    { priority: 1 }
  )
}

export async function enqueueNotification(payload: NotifyJobPayload) {
  return notifyQueue.add('notify', payload)
}

export async function enqueueWeeklyUpdate(orderId: string, delayMs: number) {
  return notifyQueue.add(
    'notify',
    { order_id: orderId, type: 'weekly_update' as const },
    { delay: delayMs, repeat: { every: 7 * 24 * 60 * 60_000 } }
  )
}

// ─── Queue event monitoring ────────────────────────────────────────────────────

export const scanQueueEvents = new QueueEvents('scan', { connection })
export const bookingQueueEvents = new QueueEvents('booking', { connection })
