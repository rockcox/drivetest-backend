import { Router, Request, Response } from 'express'
import { constructWebhookEvent } from '../services/payment'
import { payments, orders, scanJobs } from '../db/client'
import { enqueueScanJob } from '../queue/index'
import { childLogger } from '../utils/logger'

const log = childLogger('api:webhooks')
export const webhooksRouter = Router()

/**
 * Stripe webhook endpoint.
 * Must receive raw body — configured in Express before json() middleware.
 */
webhooksRouter.post(
  '/stripe',
  async (req: Request, res: Response) => {
    const sig = req.headers['stripe-signature'] as string

    if (!sig) {
      return res.status(400).json({ error: 'Missing stripe-signature header' })
    }

    let event
    try {
      event = constructWebhookEvent(req.body as Buffer, sig)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn('Webhook signature verification failed', { error: message })
      return res.status(400).json({ error: 'Invalid signature' })
    }

    log.info(`Stripe webhook: ${event.type}`, { event_id: event.id })

    try {
      switch (event.type) {
        case 'setup_intent.succeeded': {
          // Card was successfully saved — no action needed, frontend handles activation
          const intent = event.data.object as { id: string; customer: string }
          log.info(`SetupIntent succeeded: ${intent.id}`)
          break
        }

        case 'payment_intent.succeeded': {
          const intent = event.data.object as { id: string; metadata: { order_id?: string } }
          const orderId = intent.metadata?.order_id
          if (orderId) {
            const { data: payment } = await payments['findByOrderId'] ? 
              { data: await payments.findByOrderId(orderId) } : { data: null }
            if (payment) {
              await payments.updateStatus(payment.id, 'captured', {
                captured_at: new Date().toISOString(),
              })
              log.info(`Payment captured via webhook for order: ${orderId}`)
            }
          }
          break
        }

        case 'payment_intent.payment_failed': {
          const intent = event.data.object as {
            id: string
            metadata: { order_id?: string }
            last_payment_error?: { message: string }
          }
          const orderId = intent.metadata?.order_id
          if (orderId) {
            log.warn(`Payment failed for order: ${orderId}`, {
              reason: intent.last_payment_error?.message,
            })
            await orders.updateStatus(orderId, 'failed')
          }
          break
        }

        case 'payment_intent.canceled': {
          const intent = event.data.object as { id: string; metadata: { order_id?: string } }
          const orderId = intent.metadata?.order_id
          if (orderId) {
            log.info(`Payment intent cancelled for order: ${orderId}`)
          }
          break
        }

        case 'charge.dispute.created': {
          // Dispute/chargeback — alert admin immediately
          const dispute = event.data.object as { id: string; amount: number; payment_intent: string }
          log.error('CHARGEBACK CREATED', {
            dispute_id: dispute.id,
            amount: dispute.amount,
            payment_intent: dispute.payment_intent,
          })
          // TODO: Send Slack/email alert to admin
          break
        }

        default:
          log.debug(`Unhandled webhook event type: ${event.type}`)
      }

      return res.json({ received: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('Webhook handler error', { event_type: event.type, error: message })
      // Return 200 to prevent Stripe retrying — we log for manual review
      return res.json({ received: true, error: message })
    }
  }
)
