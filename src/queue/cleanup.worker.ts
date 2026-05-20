import { Worker } from 'bullmq'
import { connection, cleanupQueue } from './index'
import { foundSlots, db } from '../db/client'
import { childLogger } from '../utils/logger'

const log = childLogger('worker:cleanup')

export function createCleanupWorker() {
  const worker = new Worker(
    'cleanup',
    async (job) => {
      const { task } = job.data as { task: string }
      log.debug(`Running cleanup task: ${task}`)

      switch (task) {
        case 'expire_slots':
          await expireStaleSlots()
          break
        case 'resume_expired_orders':
          await resumeOrdersWithExpiredSlots()
          break
        case 'purge_old_logs':
          await purgeOldNotificationLogs()
          break
      }
    },
    { connection, concurrency: 1 }
  )

  log.info('Cleanup worker started')
  return worker
}

/**
 * Schedule all cleanup tasks as repeating jobs.
 */
export async function scheduleCleanupJobs() {
  // Expire stale slots every 5 minutes
  await cleanupQueue.add('expire-slots', { task: 'expire_slots' }, {
    repeat: { every: 5 * 60_000 },
    removeOnComplete: 5,
  })

  // Resume orders whose slots expired, every 5 minutes
  await cleanupQueue.add('resume-expired', { task: 'resume_expired_orders' }, {
    repeat: { every: 5 * 60_000 },
    removeOnComplete: 5,
  })

  // Purge old notification logs daily
  await cleanupQueue.add('purge-logs', { task: 'purge_old_logs' }, {
    repeat: { every: 24 * 60 * 60_000 },
    removeOnComplete: 2,
  })

  log.info('Cleanup jobs scheduled')
}

async function expireStaleSlots() {
  await foundSlots.expireOld()
  log.debug('Stale slots expired')
}

async function resumeOrdersWithExpiredSlots() {
  // Find orders in slot_found state with no pending slots
  const { data: staleOrders } = await db
    .from('orders')
    .select('id')
    .eq('status', 'slot_found')

  if (!staleOrders?.length) return

  for (const order of staleOrders) {
    const { count } = await db
      .from('found_slots')
      .select('*', { count: 'exact', head: true })
      .eq('order_id', order.id)
      .eq('status', 'pending')

    if ((count ?? 0) === 0) {
      // Slot expired without user confirming — resume scan
      log.info(`Resuming scan for order ${order.id} — slot expired`)
      await db.from('orders').update({ status: 'scanning' }).eq('id', order.id)
      const { data: scanJob } = await db
        .from('scan_jobs')
        .select('id')
        .eq('order_id', order.id)
        .single()

      if (scanJob) {
        await db.from('scan_jobs').update({
          status: 'active',
          next_scan_at: new Date().toISOString(),
        }).eq('id', scanJob.id)

        const { enqueueScanJob } = await import('./index')
        await enqueueScanJob(order.id, scanJob.id)
      }
    }
  }
}

async function purgeOldNotificationLogs() {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60_000).toISOString()
  const { error } = await db
    .from('notification_log')
    .delete()
    .lt('sent_at', cutoff)

  if (!error) log.info('Old notification logs purged')
}
