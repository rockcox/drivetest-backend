export type TestClass = 'G' | 'G2' | 'M' | 'M2' | 'A' | 'AZ' | 'B' | 'C' | 'D' | 'F'

export type TimePref = 'any' | 'morning' | 'afternoon' | 'weekdays' | 'weekends'

export type OrderStatus =
  | 'pending'
  | 'scanning'
  | 'slot_found'
  | 'confirming'
  | 'booked'
  | 'failed'
  | 'cancelled'
  | 'expired'

export type PaymentStatus = 'authorized' | 'captured' | 'refunded' | 'failed'

export type JobStatus = 'active' | 'paused' | 'completed' | 'failed' | 'waiting'

export interface User {
  id: string
  email: string
  phone: string
  stripe_customer_id?: string
  created_at: string
}

export interface Order {
  id: string
  user_id: string
  licence_number_enc: string   // AES-256 encrypted
  licence_expiry: string       // YYYY-MM-DD
  test_class: TestClass
  locations: string[]          // DriveTest centre names
  date_from: string
  date_to: string
  time_pref: TimePref
  status: OrderStatus
  service_fee_cents: number
  mto_fee_cents: number        // 0 if user pays separately
  created_at: string
  updated_at: string
}

export interface ScanJob {
  id: string
  order_id: string
  status: JobStatus
  current_location?: string
  last_scan_at?: string
  scan_count: number
  next_scan_at?: string
  worker_id?: string
  error_log: ScanError[]
  created_at: string
}

export interface ScanError {
  timestamp: string
  type: 'auth' | 'rate_limit' | 'captcha' | 'network' | 'parse' | 'unknown'
  message: string
  location?: string
}

export interface FoundSlot {
  id: string
  order_id: string
  location: string
  test_date: string            // YYYY-MM-DD
  test_time: string            // HH:MM
  found_at: string
  status: 'pending' | 'confirmed' | 'expired' | 'rejected'
  expires_at: string
}

export interface Booking {
  id: string
  order_id: string
  found_slot_id: string
  drivetest_confirmation: string
  location: string
  test_date: string
  test_time: string
  booked_at: string
}

export interface Payment {
  id: string
  order_id: string
  setup_intent_id?: string
  payment_intent_id?: string
  amount_cents: number
  status: PaymentStatus
  captured_at?: string
  refunded_at?: string
}

// Queue job payloads
export interface ScanJobPayload {
  order_id: string
  scan_job_id: string
}

export interface BookingJobPayload {
  order_id: string
  found_slot_id: string
}

export interface NotifyJobPayload {
  order_id: string
  type: 'slot_found' | 'booked' | 'cancelled' | 'failed' | 'weekly_update'
  slot?: FoundSlot
  booking?: Booking
}

// Scanner internals
export interface AvailableSlot {
  location: string
  date: string
  time: string
  centre_id: string
}

export interface DriveTestSession {
  order_id: string
  authenticated: boolean
  session_cookies?: string
  proxy_ip?: string
}
