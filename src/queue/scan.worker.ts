import { Worker } from 'bullmq'
import { connection } from './index'
import { runScanPass } from '../scanner/engine'
import { orders, scanJobs } from '../db/client'
import { config } from '../config'
import { childLogger } from '../utils/logger'
import type { ScanJobPayload } from '../types'

const log = childLogger('worker:scan')

export function createScanWorker() {
  const worker = new Worker<ScanJobPayload>(
    'scan',
    async (job) => {
      const { order_id, scan_job_id } = job.data
      log.info(`Processing scan job`, { order_id, job_id: job.id })

      const [order, scanJob] = await Promise.all([
        orders.findById(order_id),
        scanJobs.findByOrderId(order_id),
      ])

      // Skip if order is no longer active
      if (!['scanning', 'pending'].includes(order.status)) {
        log.info(`Order ${order_id} status=${order.status}, skipping scan`)
        return { skipped: true }
      }

      // Skip if scan job is paused
      if (scanJob.status === 'paused') {
        log.info(`Scan job paused for order ${order_id}`)
        return { skipped: true }
      }

      // Mark worker as active on this job
      await scanJobs.update(scanJob.id, {
        worker_id: `worker-${process.pid}`,
        status: 'active',
      })

      const result = await runScanPass(order, scanJob)
      return result
    },
    {
      connection,
      concurrency: config.worker.maxConcurrentSessions,
      limiter: { max: 10, duration: 60_000 },  // Max 10 jobs per minute
    }
  )

  worker.on('completed', (job, result) => {
    if (!result?.skipped) {
      log.info(`Scan completed`, { job_id: job.id, found: result?.found })
    }
  })

  worker.on('failed', (job, err) => {
    log.error(`Scan job failed`, { job_id: job?.id, error: err.message })
  })

  worker.on('error', (err) => {
    log.error('Worker error', { error: err.message })
  })

  log.info('Scan worker started', { concurrency: config.worker.maxConcurrentSessions })
  return worker
}
