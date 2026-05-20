import type { Page } from 'playwright'
import { scanPause, randomDelay, shuffle } from '../utils/timing'
import { childLogger } from '../utils/logger'
import type { Order, AvailableSlot } from '../types'

const log = childLogger('scanner:availability')

// Full list of Ontario DriveTest centres
export const DRIVETEST_CENTRES = [
  'Arnprior', 'Atikokan', 'Bancroft', 'Barrie', 'Belleville', 'Blind River',
  'Brampton', 'Brantford', 'Brockville', 'Burlington', 'Carleton Place',
  'Casselman', 'Chatham', 'Clinton', 'Cochrane', 'Collingwood', 'Cornwall',
  'Dryden', 'Guelph', 'Hamilton', 'Hawkesbury', 'Hearst', 'Huntsville',
  'Kapuskasing', 'Kemptville', 'Kenora', 'Kingston', 'Kirkland Lake',
  'Kitchener', 'Leamington', 'Lindsay', 'London', 'Mississauga', 'Newmarket',
  'North Bay', 'Oakville', 'Orangeville', 'Orillia', 'Oshawa',
  'Ottawa Canotek', 'Ottawa Walkley', 'Owen Sound', 'Parry Sound', 'Pembroke',
  'Peterborough', 'Port Hope', 'Sarnia', 'Sault Ste. Marie', 'Simcoe',
  'St. Catharines', 'Stratford', 'Sudbury', 'Thunder Bay', 'Timmins',
  'Toronto Downsview', 'Toronto Etobicoke', 'Toronto Metro East', 'Toronto Port Union',
  'Windsor', 'Woodstock'
] as const

export type DrivetestCentre = typeof DRIVETEST_CENTRES[number]

/**
 * Scan all preferred locations for this order and return the first matching slot found.
 * Locations are shuffled each pass to distribute load.
 */
export async function scanLocations(
  page: Page,
  order: Order
): Promise<AvailableSlot | null> {
  const l = log.child({ order_id: order.id })
  const locations = shuffle(order.locations)

  l.info(`Scanning ${locations.length} locations`)

  for (const location of locations) {
    try {
      l.debug(`Checking location: ${location}`)
      const slot = await checkLocation(page, location, order)
      if (slot) {
        l.info(`Slot found at ${location}`, { slot })
        return slot
      }
      await scanPause()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      l.warn(`Error scanning ${location}`, { error: msg })
      await randomDelay(2000, 5000)
    }
  }

  l.info('No slots found in this pass')
  return null
}

/**
 * Check a single DriveTest centre for available appointments.
 */
async function checkLocation(
  page: Page,
  location: string,
  order: Order
): Promise<AvailableSlot | null> {
  // Select location from dropdown
  const locationSelect = page.locator('#locationSelect, select[name="centre"], .centre-select')
  await locationSelect.first().selectOption({ label: location })
  await randomDelay(1200, 2500)

  // Wait for calendar to load
  await page.waitForSelector('.booking-date, .calendar-day, td.available', {
    timeout: 10_000,
  }).catch(() => null)

  // Find white (available) date boxes — grey = full
  const availableDays = await page.locator(
    '.booking-date:not(.grey):not(.disabled), td.available, .calendar-day.open'
  ).all()

  if (availableDays.length === 0) return null

  // Filter by order date range
  for (const dayEl of availableDays) {
    const dateAttr = await dayEl.getAttribute('data-date')
      ?? await dayEl.getAttribute('data-value')
      ?? await dayEl.textContent()

    if (!dateAttr) continue

    const slotDate = parseCalendarDate(dateAttr, page)
    if (!slotDate) continue

    // Check date is in user's preferred window
    if (slotDate < new Date(order.date_from) || slotDate > new Date(order.date_to)) continue

    // Click the day to load time slots
    await dayEl.click()
    await randomDelay(800, 1800)

    const timeSlot = await findMatchingTimeSlot(page, slotDate, order, location)
    if (timeSlot) return timeSlot

    // Go back to calendar view
    const backBtn = page.locator('text=Back, .back-button, [aria-label="Back"]')
    if (await backBtn.count() > 0) {
      await backBtn.first().click()
      await randomDelay(600, 1200)
    }
  }

  return null
}

/**
 * After clicking a date, scan time slots and return one matching the user's preference.
 */
async function findMatchingTimeSlot(
  page: Page,
  date: Date,
  order: Order,
  location: string
): Promise<AvailableSlot | null> {
  const timeSlots = await page.locator(
    '.time-slot:not(.disabled), .available-time, input[name="timeSlot"]'
  ).all()

  for (const slot of timeSlots) {
    const timeText = await slot.textContent() ?? await slot.getAttribute('value')
    if (!timeText) continue

    const time = parseTime(timeText.trim())
    if (!time) continue

    // Apply time preference filter
    if (!matchesTimePref(time, order.time_pref)) continue

    // Check weekday preference
    const isWeekend = date.getDay() === 0 || date.getDay() === 6
    if (order.time_pref === 'weekdays' && isWeekend) continue
    if (order.time_pref === 'weekends' && !isWeekend) continue

    return {
      location,
      date: date.toISOString().split('T')[0],
      time,
      centre_id: location.toLowerCase().replace(/\s+/g, '-'),
    }
  }

  return null
}

function parseCalendarDate(raw: string, _page: Page): Date | null {
  // Handle formats: "2024-06-14", "June 14", "14", etc.
  const isoMatch = raw.match(/(\d{4}-\d{2}-\d{2})/)
  if (isoMatch) return new Date(isoMatch[1])

  const monthDayMatch = raw.match(/([A-Za-z]+)\s+(\d{1,2})/)
  if (monthDayMatch) {
    const year = new Date().getFullYear()
    return new Date(`${monthDayMatch[1]} ${monthDayMatch[2]}, ${year}`)
  }

  return null
}

function parseTime(raw: string): string | null {
  // Normalize "10:30 AM" → "10:30"
  const match = raw.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i)
  if (!match) return null

  let hours = parseInt(match[1])
  const minutes = match[2]
  const period = match[3]?.toUpperCase()

  if (period === 'PM' && hours !== 12) hours += 12
  if (period === 'AM' && hours === 12) hours = 0

  return `${hours.toString().padStart(2, '0')}:${minutes}`
}

function matchesTimePref(time: string, pref: Order['time_pref']): boolean {
  if (pref === 'any' || pref === 'weekdays' || pref === 'weekends') return true
  const hour = parseInt(time.split(':')[0])
  if (pref === 'morning') return hour >= 7 && hour < 12
  if (pref === 'afternoon') return hour >= 12 && hour < 18
  return true
}
