-- =============================================
-- DriveTest Appointment Service — DB Schema
-- Run in Supabase SQL editor
-- =============================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── USERS ────────────────────────────────────
CREATE TABLE users (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email             TEXT UNIQUE NOT NULL,
  phone             TEXT NOT NULL,
  stripe_customer_id TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ─── ORDERS ───────────────────────────────────
CREATE TYPE order_status AS ENUM (
  'pending', 'scanning', 'slot_found', 'confirming',
  'booked', 'failed', 'cancelled', 'expired'
);

CREATE TYPE test_class AS ENUM (
  'G', 'G2', 'M', 'M2', 'A', 'AZ', 'B', 'C', 'D', 'F'
);

CREATE TYPE time_pref AS ENUM (
  'any', 'morning', 'afternoon', 'weekdays', 'weekends'
);

CREATE TABLE orders (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  licence_number_enc  TEXT NOT NULL,        -- AES-256-GCM encrypted
  licence_expiry      DATE NOT NULL,        -- YYYY-MM-DD
  test_class          test_class NOT NULL,
  locations           TEXT[] NOT NULL,      -- Centre names
  date_from           DATE NOT NULL,
  date_to             DATE NOT NULL,
  time_pref           time_pref DEFAULT 'any',
  status              order_status DEFAULT 'pending',
  service_fee_cents   INTEGER NOT NULL,
  mto_fee_cents       INTEGER DEFAULT 0,
  notes               TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_orders_user_id ON orders(user_id);
CREATE INDEX idx_orders_status ON orders(status);

-- ─── SCAN JOBS ────────────────────────────────
CREATE TYPE job_status AS ENUM (
  'waiting', 'active', 'paused', 'completed', 'failed'
);

CREATE TABLE scan_jobs (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id         UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status           job_status DEFAULT 'waiting',
  current_location TEXT,
  last_scan_at     TIMESTAMPTZ,
  scan_count       INTEGER DEFAULT 0,
  next_scan_at     TIMESTAMPTZ,
  worker_id        TEXT,
  error_log        JSONB DEFAULT '[]',
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_scan_jobs_order_id ON scan_jobs(order_id);
CREATE INDEX idx_scan_jobs_status ON scan_jobs(status);
CREATE INDEX idx_scan_jobs_next_scan ON scan_jobs(next_scan_at) WHERE status = 'active';

-- ─── FOUND SLOTS ──────────────────────────────
CREATE TYPE slot_status AS ENUM (
  'pending', 'confirmed', 'expired', 'rejected'
);

CREATE TABLE found_slots (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id   UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  location   TEXT NOT NULL,
  test_date  DATE NOT NULL,
  test_time  TIME NOT NULL,
  found_at   TIMESTAMPTZ DEFAULT NOW(),
  status     slot_status DEFAULT 'pending',
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_found_slots_order_id ON found_slots(order_id);
CREATE INDEX idx_found_slots_expires ON found_slots(expires_at) WHERE status = 'pending';

-- ─── BOOKINGS ─────────────────────────────────
CREATE TABLE bookings (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id                UUID NOT NULL REFERENCES orders(id),
  found_slot_id           UUID NOT NULL REFERENCES found_slots(id),
  drivetest_confirmation  TEXT NOT NULL,
  location                TEXT NOT NULL,
  test_date               DATE NOT NULL,
  test_time               TIME NOT NULL,
  booked_at               TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_bookings_order_id ON bookings(order_id);

-- ─── PAYMENTS ─────────────────────────────────
CREATE TYPE payment_status AS ENUM (
  'authorized', 'captured', 'refunded', 'failed'
);

CREATE TABLE payments (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id           UUID NOT NULL REFERENCES orders(id),
  setup_intent_id    TEXT,
  payment_intent_id  TEXT,
  amount_cents       INTEGER NOT NULL,
  status             payment_status DEFAULT 'authorized',
  stripe_charge_id   TEXT,
  captured_at        TIMESTAMPTZ,
  refunded_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_payments_order_id ON payments(order_id);

-- ─── NOTIFICATION LOG ─────────────────────────
CREATE TABLE notification_log (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id   UUID NOT NULL REFERENCES orders(id),
  type       TEXT NOT NULL,
  channel    TEXT NOT NULL,  -- 'sms' | 'email'
  sent_at    TIMESTAMPTZ DEFAULT NOW(),
  success    BOOLEAN DEFAULT TRUE,
  error      TEXT
);

CREATE INDEX idx_notifications_order_id ON notification_log(order_id);

-- ─── UPDATED_AT triggers ──────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER orders_updated_at BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER scan_jobs_updated_at BEFORE UPDATE ON scan_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── ENABLE REALTIME ──────────────────────────
-- Allow live dashboard to subscribe to these tables
ALTER PUBLICATION supabase_realtime ADD TABLE scan_jobs;
ALTER PUBLICATION supabase_realtime ADD TABLE found_slots;
ALTER PUBLICATION supabase_realtime ADD TABLE orders;
