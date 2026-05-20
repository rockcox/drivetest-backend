import Stripe from 'stripe'
import { config } from '../config'
import { payments } from '../db/client'
import { childLogger } from '../utils/logger'

const log = childLogger('service:payment')

export const stripe = new Stripe(config.stripe.secretKey, {
  apiVersion: '2024-06-20',
  typescript: true,
})

// ─── Customer management ──────────────────────────────────────────────────────

export async function getOrCreateCustomer(
  email: string,
  phone: string,
  name?: string
): Promise<string> {
  const existing = await stripe.customers.list({ email, limit: 1 })
  if (existing.data.length > 0) return existing.data[0].id

  const customer = await stripe.customers.create({ email, phone, name })
  log.info(`Created Stripe customer: ${customer.id}`)
  return customer.id
}

// ─── SetupIntent — save card, authorize only ──────────────────────────────────

/**
 * Create a SetupIntent to securely save a card.
 * Returns the client_secret to pass to the frontend for Stripe.js.
 * Card is NOT charged yet.
 */
export async function createSetupIntent(customerId: string): Promise<{
  setupIntentId: string
  clientSecret: string
}> {
  const intent = await stripe.setupIntents.create({
    customer: customerId,
    payment_method_types: ['card'],
    usage: 'off_session',  // Allows charging later without user present
    metadata: { purpose: 'drivetest_booking' },
  })

  log.info(`SetupIntent created: ${intent.id}`)
  return { setupIntentId: intent.id, clientSecret: intent.client_secret! }
}

/**
 * Create a PaymentIntent in manual capture mode.
 * This authorizes (holds) the amount but doesn't charge yet.
 * Returns clientSecret for frontend confirmation.
 */
export async function authorizePayment(
  customerId: string,
  paymentMethodId: string,
  amountCents: number,
  orderId: string
): Promise<{ paymentIntentId: string; clientSecret: string }> {
  const intent = await stripe.paymentIntents.create({
    amount: amountCents,
    currency: 'cad',
    customer: customerId,
    payment_method: paymentMethodId,
    capture_method: 'manual',          // Hold funds, charge later
    confirm: true,                      // Confirm immediately
    off_session: true,                  // User not present
    metadata: { order_id: orderId },
    description: `DriveSlot — Road test booking service (Order ${orderId})`,
    statement_descriptor: 'DRIVESLOT CA',
  })

  log.info(`Payment authorized: ${intent.id} for ${amountCents}¢`)
  return { paymentIntentId: intent.id, clientSecret: intent.client_secret! }
}

/**
 * Capture a previously authorized payment after successful booking.
 */
export async function capturePayment(
  paymentDbId: string,
  amountCents: number
): Promise<void> {
  const payment = await payments.findByOrderId(paymentDbId)
  if (!payment.payment_intent_id) throw new Error('No payment intent on record')

  const intent = await stripe.paymentIntents.capture(payment.payment_intent_id, {
    amount_to_capture: amountCents,
  })

  log.info(`Payment captured: ${intent.id} — ${amountCents}¢`)
}

/**
 * Refund a captured payment (e.g. on cancellation after booking).
 */
export async function refundPayment(
  paymentIntentId: string,
  reason: Stripe.RefundCreateParams.Reason = 'requested_by_customer'
): Promise<string> {
  const refund = await stripe.refunds.create({
    payment_intent: paymentIntentId,
    reason,
  })

  log.info(`Payment refunded: ${refund.id}`)
  return refund.id
}

/**
 * Cancel a PaymentIntent that hasn't been captured yet (no charge).
 */
export async function cancelAuthorization(paymentIntentId: string): Promise<void> {
  await stripe.paymentIntents.cancel(paymentIntentId)
  log.info(`Payment intent cancelled: ${paymentIntentId}`)
}

/**
 * Get card details from a SetupIntent to use for booking payment form.
 * Returns only safe, non-sensitive card metadata.
 */
export async function getPaymentMethodDetails(setupIntentId: string): Promise<{
  cardNumber: string
  expiry: string
  cvv: string
  nameOnCard: string
  billingAddress: string
  billingCity: string
  billingPostal: string
  billingPhone: string
}> {
  const intent = await stripe.setupIntents.retrieve(setupIntentId, {
    expand: ['payment_method'],
  })

  const pm = intent.payment_method as Stripe.PaymentMethod
  if (!pm?.card) throw new Error('No card on SetupIntent')

  // Note: Stripe never exposes the full card number after tokenization.
  // In production, you'd use Stripe's off-session charging rather than
  // re-entering card details on DriveTest.ca's payment form.
  // This is a placeholder — see README for the MTO fee handling strategy.
  return {
    cardNumber: '•••• •••• •••• ' + pm.card.last4,
    expiry: `${pm.card.exp_month}/${pm.card.exp_year}`,
    cvv: '',  // Never stored by Stripe
    nameOnCard: pm.billing_details?.name ?? '',
    billingAddress: pm.billing_details?.address?.line1 ?? '',
    billingCity: pm.billing_details?.address?.city ?? '',
    billingPostal: pm.billing_details?.address?.postal_code ?? '',
    billingPhone: pm.billing_details?.phone ?? '',
  }
}

/**
 * List all payment methods for a customer.
 */
export async function listPaymentMethods(customerId: string) {
  const methods = await stripe.paymentMethods.list({
    customer: customerId,
    type: 'card',
  })
  return methods.data.map(pm => ({
    id: pm.id,
    brand: pm.card?.brand,
    last4: pm.card?.last4,
    expMonth: pm.card?.exp_month,
    expYear: pm.card?.exp_year,
  }))
}

/**
 * Construct a Stripe webhook event from raw request body.
 */
export function constructWebhookEvent(
  payload: Buffer,
  signature: string
): Stripe.Event {
  return stripe.webhooks.constructEvent(
    payload,
    signature,
    config.stripe.webhookSecret
  )
}
