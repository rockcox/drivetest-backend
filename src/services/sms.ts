import twilio from 'twilio'
import { config } from '../config'
import { childLogger } from '../utils/logger'

const log = childLogger('service:sms')
const client = twilio(config.twilio.accountSid, config.twilio.authToken)

const MAX_SMS_LENGTH = 160

/**
 * Send an SMS to a Canadian phone number.
 */
export async function sendSMS(to: string, body: string): Promise<string> {
  const normalizedTo = normalizePhone(to)
  const trimmedBody = body.length > MAX_SMS_LENGTH
    ? body.slice(0, MAX_SMS_LENGTH - 3) + '...'
    : body

  try {
    const msg = await client.messages.create({
      from: config.twilio.phoneNumber,
      to: normalizedTo,
      body: trimmedBody,
    })
    log.info(`SMS sent: ${msg.sid}`, { to: maskPhone(normalizedTo) })
    return msg.sid
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('SMS send failed', { error: message, to: maskPhone(normalizedTo) })
    throw err
  }
}

/**
 * Send "slot found" SMS with confirmation link.
 */
export async function sendSlotFoundSMS(
  phone: string,
  slot: { location: string; date: string; time: string; order_id: string; slot_id: string }
): Promise<string> {
  const confirmUrl = `${process.env.APP_URL}/order/${slot.order_id}/confirm/${slot.slot_id}`
  const formattedDate = formatDate(slot.date)
  const formattedTime = formatTime(slot.time)

  const body = `DriveSlot: Slot found — ${slot.location} on ${formattedDate} at ${formattedTime}. Confirm in 2 hrs: ${confirmUrl}`
  return sendSMS(phone, body)
}

/**
 * Send weekly "still searching" update SMS.
 */
export async function sendWeeklyUpdateSMS(
  phone: string,
  orderId: string,
  testClass: string,
  scanCount: number
): Promise<string> {
  const statusUrl = `${process.env.APP_URL}/order/${orderId}`
  const body = `DriveSlot: We've checked ${scanCount.toLocaleString()} times for your ${testClass} test. Still on it! Track: ${statusUrl}`
  return sendSMS(phone, body)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return phone.startsWith('+') ? phone : `+${digits}`
}

function maskPhone(phone: string): string {
  return phone.slice(0, 6) + '****' + phone.slice(-2)
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00Z')
  return d.toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' })
}

function formatTime(timeStr: string): string {
  const [h, m] = timeStr.split(':').map(Number)
  const period = h >= 12 ? 'PM' : 'AM'
  const hour = h % 12 || 12
  return `${hour}:${m.toString().padStart(2, '0')} ${period}`
}
