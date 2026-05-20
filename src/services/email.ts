import { Resend } from 'resend'
import { config } from '../config'
import { childLogger } from '../utils/logger'
import type { FoundSlot, Booking, Order } from '../types'

const log = childLogger('service:email')
const resend = new Resend(config.resend.apiKey)

export interface EmailPayload {
  subject: string
  template: 'slot-found' | 'booking-confirmed' | 'cancelled' | 'welcome' | 'weekly-update'
  data: Record<string, unknown>
}

/**
 * Send a transactional email via Resend.
 */
export async function sendEmail(to: string, payload: EmailPayload): Promise<string> {
  const html = renderTemplate(payload.template, payload.data)

  try {
    const { data, error } = await resend.emails.send({
      from: config.resend.from,
      to,
      subject: payload.subject,
      html,
    })

    if (error) throw new Error(error.message)
    log.info(`Email sent: ${data?.id}`, { template: payload.template })
    return data?.id ?? ''
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Email send failed', { error: message, template: payload.template })
    throw err
  }
}

/**
 * Convenience: send slot-found email.
 */
export async function sendSlotFoundEmail(
  email: string,
  slot: { location: string; date: string; time: string; order_id: string; slot_id: string }
): Promise<string> {
  const confirmUrl = `${config.app.url}/order/${slot.order_id}/confirm/${slot.slot_id}`
  const statusUrl = `${config.app.url}/order/${slot.order_id}`
  const formattedDate = formatDate(slot.date)
  const formattedTime = formatTime(slot.time)

  return sendEmail(email, {
    subject: `Slot found — ${slot.location} on ${formattedDate}`,
    template: 'slot-found',
    data: { slot, confirmUrl, statusUrl, formattedDate, formattedTime },
  })
}

// ─── HTML Templates ───────────────────────────────────────────────────────────

function renderTemplate(template: EmailPayload['template'], data: Record<string, unknown>): string {
  const base = (content: string, previewText: string) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>DriveSlot</title>
  <style>
    body { margin:0; padding:0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#f4f4f0; color:#1a1a18; }
    .wrap { max-width:560px; margin:40px auto; background:#fff; border-radius:12px; overflow:hidden; border:1px solid #e4e2da; }
    .header { background:#1a1a18; padding:24px 32px; }
    .logo { color:#fff; font-size:18px; font-weight:500; letter-spacing:-0.3px; }
    .body { padding:32px; }
    .slot-card { background:#f4f4f0; border-radius:8px; padding:20px 24px; margin:20px 0; }
    .slot-label { font-size:11px; font-weight:500; text-transform:uppercase; letter-spacing:.06em; color:#888; margin-bottom:4px; }
    .slot-value { font-size:16px; font-weight:500; color:#1a1a18; }
    .btn { display:inline-block; background:#1a1a18; color:#fff; padding:12px 28px; border-radius:8px; text-decoration:none; font-size:14px; font-weight:500; margin:8px 0; }
    .btn-secondary { background:#f4f4f0; color:#1a1a18; }
    .note { font-size:12px; color:#888; margin-top:16px; line-height:1.6; }
    .footer { background:#f4f4f0; padding:20px 32px; font-size:11px; color:#888; border-top:1px solid #e4e2da; }
    p { font-size:14px; line-height:1.7; color:#444; margin:0 0 16px; }
    h2 { font-size:22px; font-weight:500; margin:0 0 16px; color:#1a1a18; }
  </style>
</head>
<body>
  <span style="display:none;max-height:0;overflow:hidden">${previewText}</span>
  <div class="wrap">
    <div class="header"><div class="logo">DriveSlot</div></div>
    <div class="body">${content}</div>
    <div class="footer">
      DriveSlot is an independent third-party booking service. We are not affiliated with the Ministry of Transportation or DriveTest. &nbsp;·&nbsp; <a href="${config.app.url}/unsubscribe" style="color:#888">Unsubscribe</a>
    </div>
  </div>
</body>
</html>`

  switch (template) {
    case 'slot-found': {
      const { slot, confirmUrl, statusUrl, formattedDate, formattedTime } = data as any
      return base(`
        <h2>We found a slot for you</h2>
        <p>Good news — we found an available road test appointment that matches your preferences.</p>
        <div class="slot-card">
          <div class="slot-label">Location</div>
          <div class="slot-value" style="margin-bottom:12px">${slot.location} DriveTest Centre</div>
          <div class="slot-label">Date</div>
          <div class="slot-value" style="margin-bottom:12px">${formattedDate}</div>
          <div class="slot-label">Time</div>
          <div class="slot-value">${formattedTime}</div>
        </div>
        <p>You have <strong>2 hours</strong> to confirm this appointment. If we don't hear from you, we'll keep searching.</p>
        <a href="${confirmUrl}" class="btn">Confirm this appointment</a><br>
        <a href="${statusUrl}" class="btn btn-secondary" style="margin-top:8px">View status page</a>
        <p class="note">You will only be charged our service fee ($59) after confirmation. The DriveTest road test fee is separate.</p>
      `, `Slot found — ${slot.location} on ${formattedDate} at ${formattedTime}`)
    }

    case 'booking-confirmed': {
      const { booking, statusUrl } = data as any
      const calUrl = buildCalendarUrl(booking)
      return base(`
        <h2>You're booked!</h2>
        <p>Your road test has been confirmed. Here are your appointment details:</p>
        <div class="slot-card">
          <div class="slot-label">Confirmation number</div>
          <div class="slot-value" style="margin-bottom:12px;font-family:monospace">${booking.drivetest_confirmation}</div>
          <div class="slot-label">Location</div>
          <div class="slot-value" style="margin-bottom:12px">${booking.location} DriveTest Centre</div>
          <div class="slot-label">Date &amp; time</div>
          <div class="slot-value">${formatDate(booking.test_date)} at ${formatTime(booking.test_time)}</div>
        </div>
        <a href="${calUrl}" class="btn">Add to calendar</a>
        <a href="${statusUrl}" class="btn btn-secondary" style="margin-top:8px;margin-left:8px">View booking</a>
        <p class="note">Remember to arrive 30 minutes early and bring your Ontario driver's licence. Your vehicle must pass a basic safety inspection.</p>
      `, `Confirmed: ${booking.drivetest_confirmation} — ${booking.location} on ${formatDate(booking.test_date)}`)
    }

    case 'welcome': {
      const { statusUrl } = data as any
      return base(`
        <h2>Your search is active</h2>
        <p>We're now scanning DriveTest centres 24/7 for a slot that matches your preferences. You'll get a text message and email the moment we find one.</p>
        <p>You can track your search in real time on your status page:</p>
        <a href="${statusUrl}" class="btn">View live status</a>
        <p class="note">Average time to find a slot: 1–5 days. You are only charged when we successfully book your appointment.</p>
      `, 'Your DriveSlot search is now active — we\'ll text you when we find a slot')
    }

    case 'cancelled': {
      const { statusUrl } = data as any
      return base(`
        <h2>Search cancelled</h2>
        <p>Your appointment search has been cancelled. No charge has been made to your card.</p>
        <a href="${statusUrl}" class="btn">Start a new search</a>
      `, 'Your DriveSlot search has been cancelled')
    }

    case 'weekly-update': {
      const { scanCount, statusUrl, testClass } = data as any
      return base(`
        <h2>Still searching for you</h2>
        <p>We've checked <strong>${Number(scanCount).toLocaleString()} times</strong> for your ${testClass} road test. Slots are competitive — we'll text you the moment one opens.</p>
        <a href="${statusUrl}" class="btn">View live status</a>
        <p class="note">To cancel your search at any time, visit your status page.</p>
      `, `Weekly update: ${Number(scanCount).toLocaleString()} scans done for your ${testClass} test`)
    }

    default:
      return base('<p>No content</p>', '')
  }
}

function buildCalendarUrl(booking: { location: string; test_date: string; test_time: string }): string {
  const start = `${booking.test_date}T${booking.test_time}:00`
  const end = `${booking.test_date}T${addHour(booking.test_time)}:00`
  const title = encodeURIComponent(`DriveTest — ${booking.location}`)
  const details = encodeURIComponent('Bring your Ontario licence. Arrive 30 min early.')
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${start.replace(/[-:]/g, '')}/${end.replace(/[-:]/g, '')}&details=${details}`
}

function addHour(time: string): string {
  const [h, m] = time.split(':').map(Number)
  return `${String((h + 1) % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00Z')
  return d.toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}

function formatTime(timeStr: string): string {
  const [h, m] = timeStr.split(':').map(Number)
  const period = h >= 12 ? 'PM' : 'AM'
  const hour = h % 12 || 12
  return `${hour}:${m.toString().padStart(2, '0')} ${period}`
}
