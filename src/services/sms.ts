import { config } from '../config'
import { childLogger } from '../utils/logger'

const log = childLogger('service:sms')

// Lazily initialise Twilio only if real credentials exist
function getClient() {
  const sid = config.twilio.accountSid
  const token = config.twilio.authToken
  if (!sid || sid.startsWith('AC') === false || sid.includes('placeholder')) {
    return null
  }
  const twilio = require('twilio')
  return twilio(sid, token)
}

const MAX_SMS_LENGTH = 160

export async function sendSMS(to: string, body: string): Promise<string> {
  const client = getClient()
  if (!client) {
    log.warn(`SMS skipped (no Twilio credentials) — would have sent to ${maskPhone(to)}: "${body.slice(0, 60)}..."`)
    return 'sms-skipped'
  }

  const normalizedTo = normalizePhone(to)
  const trimmedBody = body.length > MAX_SMS_LENGTH ? body.slice(0, MAX_SMS_LENGTH - 3) + '...' : body

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
    log.error('SMS send failed — continuing without SMS', { error: message, to: maskPhone(normalizedTo) })
    return 'sms-failed'  // Don't throw — SMS failure should never block a booking
  }
}

export async function sendSlotFoundSMS(
  phone: string,
  slot: { location: string; date: string; time: string; order_id: string; slot_id: string }
): Promise<string> {
  const confirmUrl = `${config.app.url}/status/${slot.order_id}`
  const body = `AppointMe: Slot found — ${slot.location} on ${formatDate(slot.date)} at ${formatTime(slot.time)}. Confirm: ${confirmUrl}`
  return sendSMS(phone, body)
}

export async function sendWeeklyUpdateSMS(
  phone: string,
  orderId: string,
  testClass: string,
  scanCount: number
): Promise<string> {
  const statusUrl = `${config.app.url}/status/${orderId}`
  const body = `AppointMe: Checked ${scanCount.toLocaleString()}x for your ${testClass} test. Still searching. Track: ${statusUrl}`
  return sendSMS(phone, body)
}

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
