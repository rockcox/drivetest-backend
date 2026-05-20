import { createClient } from '@supabase/supabase-js'
import { config } from '../config'
import type {
  User, Order, ScanJob, FoundSlot, Booking, Payment
} from '../types'

// Service-role client — bypasses RLS, only used server-side
export const db = createClient(
  config.supabase.url,
  config.supabase.serviceRoleKey,
  {
    auth: { persistSession: false },
    realtime: { params: { eventsPerSecond: 10 } },
  }
)

// ─── Typed query helpers ──────────────────────────────────────────────────────

export const users = {
  async findById(id: string) {
    const { data, error } = await db.from('users').select('*').eq('id', id).single()
    if (error) throw error
    return data as User
  },

  async findByEmail(email: string) {
    const { data } = await db.from('users').select('*').eq('email', email).maybeSingle()
    return data as User | null
  },

  async upsert(user: Omit<User, 'id' | 'created_at'>) {
    const { data, error } = await db
      .from('users')
      .upsert(user, { onConflict: 'email' })
      .select()
      .single()
    if (error) throw error
    return data as User
  },
}

export const orders = {
  async findById(id: string) {
    const { data, error } = await db.from('orders').select('*').eq('id', id).single()
    if (error) throw error
    return data as Order
  },

  async findActiveByUser(userId: string) {
    const { data, error } = await db
      .from('orders')
      .select('*')
      .eq('user_id', userId)
      .not('status', 'in', '("booked","cancelled","expired")')
      .order('created_at', { ascending: false })
    if (error) throw error
    return (data ?? []) as Order[]
  },

  async create(order: Omit<Order, 'id' | 'created_at' | 'updated_at'>) {
    const { data, error } = await db.from('orders').insert(order).select().single()
    if (error) throw error
    return data as Order
  },

  async updateStatus(id: string, status: Order['status']) {
    const { error } = await db.from('orders').update({ status }).eq('id', id)
    if (error) throw error
  },
}

export const scanJobs = {
  async findByOrderId(orderId: string) {
    const { data, error } = await db
      .from('scan_jobs')
      .select('*')
      .eq('order_id', orderId)
      .single()
    if (error) throw error
    return data as ScanJob
  },

  async findDue() {
    const { data, error } = await db
      .from('scan_jobs')
      .select('*, orders!inner(*)')
      .eq('status', 'active')
      .lte('next_scan_at', new Date().toISOString())
      .order('next_scan_at', { ascending: true })
      .limit(50)
    if (error) throw error
    return (data ?? []) as (ScanJob & { orders: Order })[]
  },

  async create(job: Omit<ScanJob, 'id' | 'created_at' | 'updated_at'>) {
    const { data, error } = await db.from('scan_jobs').insert(job).select().single()
    if (error) throw error
    return data as ScanJob
  },

  async update(id: string, updates: Partial<ScanJob>) {
    const { error } = await db.from('scan_jobs').update(updates).eq('id', id)
    if (error) throw error
  },

  async appendError(id: string, err: ScanJob['error_log'][0]) {
    const { data } = await db.from('scan_jobs').select('error_log').eq('id', id).single()
    const log = [...((data?.error_log as ScanJob['error_log']) ?? []), err]
    const { error } = await db.from('scan_jobs').update({ error_log: log }).eq('id', id)
    if (error) throw error
  },
}

export const foundSlots = {
  async create(slot: Omit<FoundSlot, 'id' | 'found_at'>) {
    const { data, error } = await db.from('found_slots').insert(slot).select().single()
    if (error) throw error
    return data as FoundSlot
  },

  async findById(id: string) {
    const { data, error } = await db.from('found_slots').select('*').eq('id', id).single()
    if (error) throw error
    return data as FoundSlot
  },

  async updateStatus(id: string, status: FoundSlot['status']) {
    const { error } = await db.from('found_slots').update({ status }).eq('id', id)
    if (error) throw error
  },

  async expireOld() {
    const { error } = await db
      .from('found_slots')
      .update({ status: 'expired' })
      .eq('status', 'pending')
      .lt('expires_at', new Date().toISOString())
    if (error) throw error
  },
}

export const bookings = {
  async create(booking: Omit<Booking, 'id' | 'booked_at'>) {
    const { data, error } = await db.from('bookings').insert(booking).select().single()
    if (error) throw error
    return data as Booking
  },
}

export const payments = {
  async create(payment: Omit<Payment, 'id' | 'captured_at' | 'refunded_at'>) {
    const { data, error } = await db.from('payments').insert(payment).select().single()
    if (error) throw error
    return data as Payment
  },

  async findByOrderId(orderId: string) {
    const { data, error } = await db
      .from('payments').select('*').eq('order_id', orderId).single()
    if (error) throw error
    return data as Payment
  },

  async updateStatus(id: string, status: Payment['status'], extra?: Partial<Payment>) {
    const { error } = await db.from('payments').update({ status, ...extra }).eq('id', id)
    if (error) throw error
  },
}

export const notificationLog = {
  async record(entry: {
    order_id: string
    type: string
    channel: string
    success: boolean
    error?: string
  }) {
    await db.from('notification_log').insert(entry)
  },
}
