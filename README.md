# DriveSlot Backend

Automated DriveTest.ca appointment finder for Ontario. Scans for cancellations 24/7 and books the moment a slot matching user preferences appears.

---

## Architecture

```
src/
├── index.ts                  # Express API server
├── config/index.ts           # Env var config
├── types/index.ts            # Shared TypeScript types
├── utils/
│   ├── crypto.ts             # AES-256-GCM encryption for licence numbers
│   ├── timing.ts             # Human-like delays and jitter
│   └── logger.ts             # Winston structured logging
├── db/
│   ├── schema.sql            # PostgreSQL schema (run in Supabase)
│   └── client.ts             # Typed Supabase query helpers
├── scanner/
│   ├── auth.ts               # DriveTest.ca login via Playwright
│   ├── availability.ts       # Calendar polling + slot detection
│   ├── booking.ts            # Booking flow + CAPTCHA solve
│   └── engine.ts             # Orchestrates scan passes
├── services/
│   ├── payment.ts            # Stripe SetupIntent + capture + refund
│   ├── sms.ts                # Twilio SMS
│   ├── email.ts              # Resend email + HTML templates
│   └── captcha.ts            # 2captcha integration
├── queue/
│   ├── index.ts              # BullMQ queue definitions
│   ├── scan.worker.ts        # Processes scan jobs
│   ├── booking.worker.ts     # Confirms slots, captures payment
│   ├── notify.worker.ts      # SMS + email dispatch
│   ├── cleanup.worker.ts     # Expires slots, purges logs
│   └── worker-runner.ts      # Starts all workers
└── api/
    ├── orders.ts             # Order CRUD endpoints
    ├── status.ts             # Dashboard status endpoint
    └── webhooks.ts           # Stripe event handler
```

---

## Prerequisites

- Node.js 20+
- Redis (local or Upstash)
- Supabase project
- Stripe account (test mode for dev)
- Twilio account with a Canadian number
- Resend account
- 2captcha account
- (Optional) BrightData or Oxylabs residential proxy

---

## Setup

### 1. Install dependencies

```bash
npm install
npx playwright install chromium
```

### 2. Configure environment

```bash
cp .env.example .env
# Fill in all values in .env
```

Generate an encryption key:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. Create the database

In your Supabase project → SQL Editor, paste and run the contents of `src/db/schema.sql`.

Enable Realtime on the `scan_jobs`, `found_slots`, and `orders` tables (already in schema).

### 4. Run locally

**Terminal 1 — API server:**
```bash
npm run dev
```

**Terminal 2 — Workers:**
```bash
npm run worker
```

---

## API Reference

### Create order
```
POST /orders
{
  "email": "user@example.com",
  "phone": "4165551234",
  "licenceNumber": "A1234-56789-00000",
  "licenceExpiry": "2027-03-15",
  "testClass": "G2",
  "locations": ["Toronto Etobicoke", "Mississauga", "Brampton"],
  "dateFrom": "2025-06-01",
  "dateTo": "2025-07-31",
  "timePref": "any"
}

→ 201 { orderId, payment: { clientSecret, feeFormatted } }
```

### Activate order (after Stripe.js confirms card)
```
POST /orders/:id/activate
{ "paymentMethodId": "pm_..." }

→ 200 { status: "scanning" }
```

### Confirm a found slot
```
POST /orders/:id/confirm/:slotId

→ 200 { status: "confirming" }
```

### Reject a slot (keep searching)
```
POST /orders/:id/reject-slot
{ "slotId": "..." }

→ 200 { status: "scanning" }
```

### Cancel order
```
POST /orders/:id/cancel

→ 200 { status: "cancelled" }
```

### Update preferences mid-search
```
PATCH /orders/:id
{ "locations": [...], "timePref": "morning", "dateTo": "2025-08-31" }
```

### Get order status (for dashboard)
```
GET /status/:orderId

→ { order, scanner, foundSlot, booking, notifications }
```

### Health check
```
GET /health → { status: "ok" }
```

### Get all DriveTest centre locations
```
GET /locations → { locations: [...] }
```

---

## Deployment

### API Server (Fly.io / Railway / Render)

```bash
# Fly.io example
flyctl launch
flyctl secrets set SUPABASE_URL=... STRIPE_SECRET_KEY=... (etc)
flyctl deploy
```

### Workers (same VPS or separate)

Workers are CPU-light but need RAM for Playwright. One $20/mo VPS handles 20 concurrent sessions.

For production, separate the API and workers:
- API: Fly.io / Vercel (serverless)
- Workers: Hetzner CPX31 (4 vCPU, 8GB RAM) — ~$16/mo

### Redis

Use Upstash (free tier for dev, $10/mo for production with persistence).

---

## Key design decisions

### Why Playwright not direct API calls?
DriveTest.ca has no public API. The booking system is a server-rendered web app that requires session cookies, a CAPTCHA at checkout, and a real browser to navigate. Playwright mimics a real user session using the user's own credentials.

### Why AES-256-GCM for licence numbers?
Ontario licence numbers are government-issued IDs. They must be encrypted at rest (not just hashed — we need to decrypt them to log in on the user's behalf). The encryption key lives in the environment, never in the database. After a booking is confirmed, the decrypted value is immediately discarded — only the encrypted blob is stored.

### Why Stripe SetupIntent not immediate charge?
We authorize (hold) the service fee when the user saves their card, but only capture it after a successful booking. This is the "pay on success" model from SacaCitas — users never pay for a slot we didn't find.

### Why BullMQ not cron?
Cron fires at fixed intervals globally. BullMQ lets each order have its own independent, jittered schedule. This distributes load, looks more human, and allows per-order retry strategies.

### MTO fee handling
The DriveTest.ca road test fee ($53.75 G2, $91.25 G) is charged directly by MTO via their payment form. We submit this via the user's card details during booking completion. This requires the user's card to be stored as a Stripe payment method — which we have from the SetupIntent flow.

**Note:** Stripe never exposes full card numbers after tokenization. For the MTO payment, we have two options:
1. Ask the user to provide card details again at confirmation time (simplest, most transparent)
2. Bundle MTO fee into our own Stripe charge, then pay MTO separately (requires matching funds timing)

Option 1 is recommended for MVP.
