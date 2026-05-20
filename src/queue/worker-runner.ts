import 'dotenv/config'
import { createScanWorker } from './scan.worker'
import { createBookingWorker } from './booking.worker'
import { createNotifyWorker } from './notify.worker'
import { createCleanupWorker, scheduleCleanupJobs } from './cleanup.worker'
import { connection } from './index'
import { childLogger } from '../utils/logger'

const log = childLogger('worker-runner')

async function main() {
  log.info('Starting all workers...')

  const workers = [
    createScanWorker(),
    createBookingWorker(),
    createNotifyWorker(),
    createCleanupWorker(),
  ]

  await scheduleCleanupJobs()

  log.info(`All workers running (pid: ${process.pid})`)

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info(`Received ${signal} — shutting down workers gracefully`)
    await Promise.all(workers.map(w => w.close()))
    await connection.quit()
    log.info('All workers stopped. Bye.')
    process.exit(0)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT',  () => shutdown('SIGINT'))

  // Keep process alive
  process.stdin.resume()
}

main().catch(err => {
  log.error('Worker runner failed to start', { error: err.message })
  process.exit(1)
})
