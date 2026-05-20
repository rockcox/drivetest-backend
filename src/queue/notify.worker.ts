import { Worker } from 'bullmq'
import { connection } from './index'
import { orders, notificationLog } from '../db/client'
import { sendSMS } from '../services/sms'
import { sendEmail } from '../services/email'
import { childLogger } from '../utils/logger'
import type { NotifyJobPayload } from '../types'

const log = childLogger('worker:notify')

export function createNotifyWorker() {
  const worker = new Worker<NotifyJobPayload>(
    'notify',
    async (job) => {
      const { order_id, type, slot, booking } = job.data
      const l = log.child({ order_id, type })

      const order = await orders.findById(order_id)
      const { users } = await import('../db/client')
      const user = await users.findById(order.user_id)

      l.info(`Sending ${type} notification`)

      const results = await Promise.allSettled(
        buildNotifications(type, user, order, slot, booking)
      )

      for (const [i, result] of results.entries()) {
        const channel = i === 0 ? 'sms' : 'email'
        if (result.status === 'rejected') {
          l.warn(`${channel} notification failed`, { error: result.reason?.message })
          await notificationLog.record({ order_id, type, channel, success: false, error: String(result.reason) })
        } else {
          await notificationLog.record({ order_id, type, channel, success: true })
        }
      }
    },
    { connection, concurrency: 10 }
  )

  worker.on('failed', (job, err) => {
    log.error('Notify job failed', { job_id: job?.id, error: err.message })
  })

  log.info('Notify worker started')
  return worker
}

function buildNotifications(
  type: NotifyJobPayload['type'],
  user: { phone: string; email: string },
  order: { id: string; test_class: string },
  slot?: NotifyJobPayload['slot'],
  booking?: NotifyJobPayload['booking']
) {
  const confirmUrl = `${process.env.APP_URL}/order/${order.id}/confirm`
  const statusUrl = `${process.env.APP_URL}/order/${order.id}`

  switch (type) {
    case 'slot_found':
      return [
        sendSMS(
          user.phone,
          `DriveSlot: We found a ${order.test_class} test at ${slot?.location} on ${slot?.test_date} at ${slot?.test_time}. Confirm within 2 hrs: ${confirmUrl}`
        ),
        sendEmail(user.email, {
          subject: `Slot found — ${order.test_class} at ${slot?.location}`,
          template: 'slot-found',
          data: { slot, confirmUrl, statusUrl, order },
        }),
      ]

    case 'booked':
      return [
        sendSMS(
          user.phone,
          `DriveSlot: Booked! Your ${order.test_class} test is confirmed at ${booking?.location} on ${booking?.test_date} at ${booking?.test_time}. Ref: ${booking?.drivetest_confirmation}`
        ),
        sendEmail(user.email, {
          subject: `Booking confirmed — ${booking?.drivetest_confirmation}`,
          template: 'booking-confirmed',
          data: { booking, order, statusUrl },
        }),
      ]

    case 'weekly_update':
      return [
        sendSMS(user.phone, `DriveSlot: Still searching for your ${order.test_class} test. We'll text you the moment a slot opens. Check status: ${statusUrl}`),
        // No email for weekly update — just SMS
        Promise.resolve(),
      ]

    case 'cancelled':
      return [
        sendSMS(user.phone, `DriveSlot: Your search for a ${order.test_class} test has been cancelled. Visit ${statusUrl} for details.`),
        sendEmail(user.email, {
          subject: 'Search cancelled',
          template: 'cancelled',
          data: { order, statusUrl },
        }),
      ]

    default:
      return [Promise.resolve(), Promise.resolve()]
  }
}
