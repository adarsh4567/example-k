# Kaaryo — User (Customer) Service Booking Integration Guide

The end-to-end job flow for the **customer app**: raise a request → nearby
professionals are notified in real time → a 1-minute timer → one accepts and is
assigned → they do the work and mark it done → the customer pays → the
professional is credited. If nobody accepts before the timer runs out, the
customer can retry.

Base URL: `http://16.112.64.28:4000` (`PORT` in `.env`).
All bodies and responses are `application/json`. CORS is fully open.
Login and profile are covered in **USER_AUTH_INTEGRATION_GUIDE.md** — everything
here assumes you already hold a user token.

> ### The worker app does not change
> Nothing in this feature alters a single worker-facing endpoint, payload or
> socket event. `GET /api/jobs/available`, `GET /api/jobs/mine`,
> `POST /api/jobs/:id/accept|decline|complete|rate`, `PUT /api/jobs/availability`,
> `GET /api/earnings/summary` and the `jobs:open` / `job:offer` / `job:taken` /
> `job:expired` / `job:accept` / `job:decline` / `presence:update` socket
> contract are all byte-identical. No worker-side source file was touched.
> **Section 12** lists exactly what was and wasn't changed, and why.

---

## 1. The flow in one picture

```
┌─ Category picker ───────────────────────────────────────────────┐
│  GET /api/services                    → categories + prices     │
├─ Booking screen ────────────────────────────────────────────────┤
│  category, subcategory, description, location                   │
│         ↓                                                       │
│  POST /api/user/service-requests                                │
│         ↓  201 → status:'searching', searchExpiresAt (+60s)     │
├─ Searching screen ──── 1-minute countdown ──────────────────────┤
│  socket: request:searching   (a wave went out, radius grew)      │
│         ↓                                                       │
│    ┌────────────────────────┬──────────────────────────────┐    │
│    │ someone accepted       │ timer hit zero               │    │
│    │ request:accepted       │ request:expired              │    │
│    │ status:'in_progress'   │ status:'expired'             │    │
│    │         ↓              │      canRetry === true       │    │
│    │                        │         ↓                    │    │
│    │                        │  POST .../:id/retry          │    │
│    │                        │  → back to 'searching'       │    │
│    │                        │    (same id, attempt+1)      │    │
│    └────────────────────────┴──────────────────────────────┘    │
├─ Tracking screen ───────────────────────────────────────────────┤
│  worker card: name, phone, rating, distance                     │
│  worker taps "Complete" in THEIR app                            │
│         ↓  socket: request:work_done                            │
│  status:'pending_rating' · payment.payable === true              │
├─ Payment screen ────────────────────────────────────────────────┤
│  POST .../:id/payment/initiate  { method }   → orderId          │
│  POST .../:id/payment/confirm   { orderId }  → paid             │
│         ↓  socket: request:paid                                 │
│  professional credited (ledger row written)                      │
└─────────────────────────────────────────────────────────────────┘
```

Two independent tracks run on one request, and the app renders both:

| Track | Driven by | Field |
|---|---|---|
| **Job status** | the worker (accept → complete → rate) | `status` |
| **Payment status** | the customer (initiate → confirm) | `payment.status` |

They're deliberately separate. Payment falls due when the work is physically done
(`pending_rating`), **not** when the job closes (`completed`) — closing
additionally needs the worker to submit their own rating, and the customer's
ability to pay must not hang on a tap only the worker can make.

---

## 2. Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/services` | — | Categories, subcategories, prices |
| `POST` | `/api/user/service-requests` | user | Raise a request → starts the 1-min search |
| `GET` | `/api/user/service-requests` | user | My requests: `active` + `history` |
| `GET` | `/api/user/service-requests/active` | user | The one live request — call on app launch |
| `GET` | `/api/user/service-requests/:id` | user | Poll one request |
| `POST` | `/api/user/service-requests/:id/cancel` | user | Cancel |
| `POST` | `/api/user/service-requests/:id/retry` | user | Search again after it expired |
| `POST` | `/api/user/service-requests/:id/payment/initiate` | user | Open a payment → `orderId` |
| `POST` | `/api/user/service-requests/:id/payment/confirm` | user | Capture → credits the worker |

Same flat response envelope as the auth guide — `{ success, message, ...payload }`,
no `data` wrapper. Branch on `success` (or the HTTP status), then read the named
field (`request`, `active`, `payment`).

**Every one of these returns the same `request` object**, and so does every socket
event. Write one parser and one renderer; see §4 for the field reference.

---

### 2.1 `GET /api/services`

Public. The category picker must come from here — these keys are what request
creation validates, and this `price` is what the request is actually created with.
A hardcoded client-side copy is how you get a Book button that 422s.

```json
{
  "success": true,
  "message": "Service catalog",
  "currency": "INR",
  "services": [
    {
      "key": "cleaning", "name": "Cleaning", "color": "#3b82f6",
      "price": 300, "currency": "INR",
      "subcategories": [
        { "key": "basic_home", "name": "Basic home cleaning" },
        { "key": "kitchen", "name": "Kitchen cleaning" }
      ]
    },
    { "key": "electrical", "name": "Electrical", "color": "#f59e0b", "price": 400, "...": "..." }
  ]
}
```

Eight categories: `cleaning` ₹300, `electrical` ₹400, `cooking` ₹350,
`plumbing` ₹450, `carpentry` ₹500, `ac_repair` ₹600, `painting` ₹800,
`pest_control` ₹500. Flat rate card — subcategory does not change the price yet.

---

### 2.2 `POST /api/user/service-requests`

```json
{
  "category": "electrical",
  "subcategory": "wiring",
  "jobDescription": "Bedroom fan wiring keeps tripping the breaker.",
  "lat": 17.4165711,
  "lng": 78.4333269,
  "address": "Flat 402, Hitech City, Hyderabad"
}
```

| Field | Required | Notes |
|---|---|---|
| `category` | yes | A `key` from `/api/services` |
| `subcategory` | no | Must belong to that category |
| `jobDescription` | yes | ≤ 500 chars. Shown verbatim to the worker |
| `lat` / `lng` | yes | Numbers. Where the service is needed |
| `address` | no | Free text, shown to the worker |
| `radiusKm` | no | Override the 3 km first-wave radius |

**Do not send the customer's name or phone.** They're read from the authenticated
account (`fullName`, `phone`) and snapshotted onto the request. Accepting them
from the body would let one account book under another person's contact details —
and the worker sees that contact once they accept.

**`201`** — the search has started and the first wave of offers is already out:

```json
{
  "success": true,
  "message": "Looking for a professional — 1 nearby worker(s) notified.",
  "workersNotified": 1,
  "searchWindowSeconds": 60,
  "request": {
    "id": "6a6b8692693797046521c5bf",
    "status": "searching",
    "category": "electrical", "categoryName": "Electrical",
    "subcategory": "wiring", "subcategoryName": "Wiring & repair",
    "jobDescription": "Bedroom fan wiring keeps tripping the breaker.",
    "totalPrice": 400, "currency": "INR",
    "address": "Flat 402, Hitech City, Hyderabad",
    "location": { "type": "Point", "coordinates": [78.4333269, 17.4165711] },
    "radiusKm": 3, "wave": 1,
    "attempt": 1, "maxAttempts": 3,
    "workersNotified": 1, "workersNotifiedTotal": 1,
    "searchStartedAt": "2026-07-30T17:14:58.945Z",
    "searchExpiresAt": "2026-07-30T17:15:58.945Z",
    "secondsRemaining": 60,
    "canRetry": false, "canCancel": true,
    "payment": {
      "status": "not_due", "payable": false,
      "amount": 400, "currency": "INR", "method": null,
      "orderId": null, "transactionId": null, "attempts": 0,
      "failureReason": null, "dueAt": null, "paidAt": null
    },
    "createdAt": "2026-07-30T17:14:58.911Z",
    "updatedAt": "2026-07-30T17:14:58.984Z"
  }
}
```

`workersNotified: 0` is **not** an error — the request is live and the radius will
widen on its own. Go to the searching screen either way and say "looking for a
professional nearby", not "no one found".

Errors:

| Code | `message` / `code` | App should |
|---|---|---|
| `422` | `Please add your name to your profile before booking a service` (`code: "PROFILE_INCOMPLETE"`) | Route to the name screen, then re-submit |
| `422` | `Invalid service category: x` | Bug — pick from `/api/services` |
| `422` | `Invalid subcategory "x" for category "y"` | Bug — same |
| `422` | `jobDescription is required` / `must be under 500 characters` | Inline field error |
| `422` | `Valid numeric lat and lng are required` | Ask for location permission again |
| `409` | `You already have a service request in progress` (`code: "REQUEST_IN_PROGRESS"`) | **The response includes the live `request`** — show that screen instead of an error |

That `409` is the double-tap guard: one live request per customer. Two searches
for the same job could put two workers on one doorstep, and nothing merges them.
Because the in-flight request comes back in the error body, the app can treat
this as a navigation event rather than a failure.

---

### 2.3 `GET /api/user/service-requests/active`

The app-launch call. Returns the single live request, or `null`.

```json
{ "success": true, "message": "Active request", "request": { "...": "..." } }
{ "success": true, "message": "No active request", "request": null }
```

"Live" means `searching`, `in_progress`, `pending_rating`, **or** `completed` with
payment still outstanding — a finished-but-unpaid job stays actionable and is the
easiest thing for a customer to lose track of after closing the app.

An `expired` request is *not* returned here. Use `GET /` (§2.4) and look for
`canRetry` if you want to offer a retry after a cold start.

---

### 2.4 `GET /api/user/service-requests`

```json
{
  "success": true,
  "message": "Your service requests",
  "active": [ { "...": "full request objects" } ],
  "history": [
    {
      "id": "...", "status": "completed",
      "category": "electrical", "categoryName": "Electrical", "subcategory": "wiring",
      "totalPrice": 400, "currency": "INR", "address": "...",
      "attempt": 1, "secondsRemaining": 0, "canRetry": false,
      "payment": { "status": "paid", "payable": false, "...": "..." },
      "createdAt": "...", "completedAt": "..."
    }
  ]
}
```

`active` carries full request objects (worker card included). `history` carries
**summaries** — same field names, minus `location`, `jobDescription` and `worker`.
Newest first, 50 max. If a history row shows `canRetry: true`, it's an expired
request the customer can still restart.

---

### 2.5 `GET /api/user/service-requests/:id`

Returns `{ success, message, request }`. This is the polling fallback if you
haven't wired the socket — see §3.

---

### 2.6 `POST /api/user/service-requests/:id/cancel`

No body. Allowed while `searching` or `in_progress` (`canCancel` tells you).

Returns `{ success, message, request }` with `status: "cancelled"`. Any worker
still holding the offer has it cleared from their screen immediately.

| Code | `message` |
|---|---|
| `409` | `Work is already done for this job — it just needs the worker's rating to finalize, so it can no longer be cancelled` |
| `409` | `Request already completed` / `cancelled` / `expired` |

No cancellation fee exists. Cancelling never creates a payment.

---

### 2.7 `POST /api/user/service-requests/:id/retry`

No body. **This is the "nobody accepted" recovery path.** Only valid on an
`expired` request with `canRetry: true`.

The request **keeps its id** — the socket subscription, the open screen and any
deep link all stay valid. Only `attempt` and the countdown reset:

```json
{
  "success": true,
  "message": "Searching again — 1 nearby worker(s) notified (attempt 2 of 3).",
  "workersNotified": 1,
  "attempt": 2,
  "maxAttempts": 3,
  "searchWindowSeconds": 60,
  "request": { "status": "searching", "attempt": 2, "radiusKm": 3, "secondsRemaining": 60, "...": "..." }
}
```

A retry starts over at the 3 km radius and **re-offers to the workers who missed
the previous attempt** — they're the ones most likely to be free now. It is a
genuine second sweep of nearby supply, not a continuation of the far-out one.

| Code | `message` / `code` | App should |
|---|---|---|
| `409` | `This request is already searching for a professional` | Just show the searching screen |
| `409` | `Cannot retry a completed/cancelled/in_progress request` | Refresh the request |
| `429` | `No professionals found after 3 attempts...` (`code: "RETRY_LIMIT_REACHED"`, `maxAttempts: 3`) | Hide Retry; offer "Book again" (a fresh request is always allowed) |

`maxAttempts` is on every request object — render "Retry (2 of 3)" from it rather
than hardcoding 3, since it's an env setting (`DISPATCH_MAX_ATTEMPTS`).

---

### 2.8 `POST /api/user/service-requests/:id/payment/initiate`

```json
{ "method": "upi" }
```

`method` ∈ `upi` | `card` | `netbanking` | `wallet` | `cash`. Requires
`payment.payable === true`.

```json
{
  "success": true,
  "message": "Payment initiated",
  "request": { "payment": { "status": "processing", "...": "..." }, "...": "..." },
  "payment": {
    "orderId": "order_ms7rxofpf565513850",
    "amount": 400, "currency": "INR",
    "method": "upi", "provider": "mock", "mode": "mock"
  }
}
```

Hand `orderId` to the gateway SDK. **In `mode: "mock"` there is no SDK** — go
straight to confirm with that `orderId`.

| Code | `message` |
|---|---|
| `409` | `The work is still in progress — you can pay once the professional marks it done` |
| `409` | `Nothing to pay on a searching/cancelled/expired request` |
| `422` | `method must be one of: upi, card, netbanking, wallet, cash` |

Already paid → `200` with no `payment` block and `message: "This job is already paid"`.

---

### 2.9 `POST /api/user/service-requests/:id/payment/confirm`

```json
{ "orderId": "order_ms7rxofpf565513850", "gatewayReference": "optional-provider-txn-id" }
```

Captures the money **and credits the professional in the same call**.

```json
{
  "success": true,
  "message": "Payment successful — the professional has been credited",
  "workerCredited": true,
  "request": {
    "payment": {
      "status": "paid", "payable": false,
      "amount": 400, "currency": "INR", "method": "upi",
      "orderId": "order_ms7rxofpf565513850",
      "transactionId": "pay_ms7rxokgddb4b18f0a",
      "attempts": 1, "failureReason": null,
      "dueAt": "...", "paidAt": "2026-07-30T17:14:59.872Z"
    },
    "...": "..."
  }
}
```

**Safe to retry.** Confirming an already-paid job returns `200` with
`workerCredited: false` and pays nobody twice — guarded by an atomic status flip
and, behind that, a unique database index on the credit row. If the response is
lost to a flaky network, just send it again.

| Code | `message` | App should |
|---|---|---|
| `402` | `Payment declined by bank...` | Show the decline; `payment.status` is now `failed` and `payable` is still `true` → call **initiate** again |
| `409` | `Start a payment first (POST /payment/initiate)` | Sequence bug |
| `409` | `orderId does not match the payment in progress` | You sent a stale `orderId`; re-initiate |

A `402` response includes the updated `request`, so the payment screen can
re-render straight from it.

---

## 3. Real-time channel (Socket.IO)

The customer app now has its own socket channel. Same server, same handshake as
the worker app, **your user token**:

```js
import { io } from 'socket.io-client';
const socket = io('http://16.112.64.28:4000', { auth: { token: userToken } });
```

Read-only. Everything the customer *does* is a REST call — those need bodies,
status codes and must work when the socket is down. The socket only pushes state.

| Event | Payload | Meaning |
|---|---|---|
| `requests:active` | `{ requests: [request] }` | Snapshot on connect — live requests |
| `request:searching` | `{ request, newlyOffered }` | A wave went out / the radius grew |
| `request:accepted` | `{ request }` | **A professional took the job** — `request.worker` is now populated |
| `request:expired` | `{ request, reason }` | Nobody accepted; `request.canRetry` says if Retry should be live |
| `request:work_done` | `{ request }` | Worker marked the work done → `payment.payable === true` |
| `request:completed` | `{ request }` | Worker submitted their rating → job closed |
| `request:paid` | `{ request }` | Payment captured, professional credited |
| `request:cancelled` | `{ request }` | Cancelled (also fires on your other devices) |

**Every payload's `request` is the identical shape the REST endpoints return.** One
render path, whichever transport delivered it.

The `requests:active` snapshot is what makes the flow survive an app restart
mid-search: a request whose timer is still running comes back with its real
`secondsRemaining`, so the countdown resumes at the right number instead of
starting over at 60.

Handshake errors arrive as `connect_error` with `err.message`:
`Auth token missing`, `Invalid or expired token`, `User not found`,
`This account has been blocked`. Treat them exactly like a REST `401` — wipe the
token and route to login.

**The socket is an optimisation, not a requirement.** Polling
`GET /api/user/service-requests/:id` every 2–3s while `status === 'searching'`
gives the same information. Ship polling first if it's simpler; add the socket to
remove the latency.

---

## 4. The `request` object — field reference

```
id                      string
status                  'searching' | 'in_progress' | 'pending_rating' | 'completed' | 'cancelled' | 'expired'

category, categoryName          'electrical', 'Electrical'   ← display the *Name fields
subcategory, subcategoryName    'wiring', 'Wiring & repair'  (both null if none)
jobDescription                  what the customer typed
totalPrice, currency            400, 'INR'  — what the customer pays
address, location               location is GeoJSON [lng, lat] — note the order

── search telemetry (the "finding a professional" screen) ──
radiusKm                current search radius, km (3 → 6 → 9 …)
wave                    monotonic broadcast counter
attempt, maxAttempts    1-based search attempt / the cap (3)
workersNotified         professionals reached THIS attempt
workersNotifiedTotal    across all attempts
searchStartedAt         when this attempt's clock started
searchExpiresAt         absolute deadline — null unless status is 'searching'
secondsRemaining        convenience snapshot; 0 unless 'searching'

── server-decided affordances: render buttons off these, don't re-derive ──
canRetry                show Retry (expired AND attempts left)
canCancel               show Cancel (searching or in_progress)

── payment ──
payment.status          'not_due' | 'due' | 'processing' | 'paid' | 'failed'
payment.payable         show the Pay button  ← the only check you need
payment.amount          400
payment.method          'upi' | 'card' | 'netbanking' | 'wallet' | 'cash' | null
payment.orderId         pass to confirm
payment.transactionId   gateway reference, set once paid
payment.attempts        how many payments have been opened
payment.failureReason   last decline message, or null
payment.dueAt, paidAt

── present only once a professional is assigned ──
worker.id, name, phone, rating, jobsCompleted, distanceKm, location
acceptedAt              also: workDoneAt, completedAt, cancelledAt, expiredAt

createdAt, updatedAt
```

Two rules worth following literally:

**Render the countdown from `searchExpiresAt`, not a local 60-second timer.** The
server owns when the search dies. A phone that was backgrounded, or whose clock is
skewed, still shows the truth:

```js
const left = Math.max(0, Math.ceil((new Date(r.searchExpiresAt) - Date.now()) / 1000));
```

**Use `payment.payable` and `canRetry`/`canCancel` as-is.** They're computed from
the dispatch and payment rules server-side. Re-implementing them as client
conditionals (`status === 'pending_rating' && payment.status === 'due'`) means
they drift the moment either side changes.

`pricing.workerEarning` and `platformFee` are deliberately absent — the
worker/platform split is internal. The customer sees only `totalPrice`.

---

## 5. The 1-minute timer — the rules

One **attempt** lasts 60 seconds end to end (`DISPATCH_SEARCH_WINDOW_SECONDS`).
Inside it, the search widens on its own:

```
t=0s    wave 1 → nearest eligible online workers within 3 km   (up to 10)
t=30s   wave 2 → radius grows to 6 km, newly-in-range workers notified
t=60s   window closes → status:'expired' → canRetry
```

- **Waves** decide *how far* we look; the **window** decides *when the customer
  gets an answer*. The window always wins — a wave started with 10s left gets 10s.
- A worker is only offered a job inside **their own** declared travel radius, so a
  worker who chose "2 km" is never offered a job 5 km away. This is why
  `workersNotified` can be 0 even in a busy area.
- **First to accept wins**, enforced atomically. Once accepted, `searchExpiresAt`
  goes `null` and `secondsRemaining` goes 0 — stop the timer on `request:accepted`.
- Expiry is guaranteed within one sweep tick (5s) of the deadline, so allow the
  odd second of slack rather than asserting exactly 60.
- All three numbers are env-tunable server-side. Read `searchWindowSeconds` from
  the create/retry response and `maxAttempts` from the request object instead of
  hardcoding 60 and 3.

---

## 6. Payment and the worker credit

```
work done ──▶ payment.status 'due'   (payable: true)
   initiate ──▶ 'processing'  + orderId
    confirm ──▶ 'paid'        + transactionId  → worker credited
            └▶ 'failed'       + failureReason  → initiate again
```

On capture the platform writes a **credit row to the professional's ledger** in the
same call: ₹400 collected → ₹40 platform fee (10%) → **₹360 credited**. The row
records the job, the gross, the fee and the gateway transaction id, so every rupee
traces back to a payment.

`PAYMENT_MODE=mock` is the default: no gateway, `confirm` captures
unconditionally. Set `PAYMENT_FORCE_FAIL=1` on the server to make every capture
decline — that's how you test the `402` path and the re-initiate flow. Switching
to a real gateway is two functions in `src/services/paymentService.js`; **none of
the request/response shapes above change**, so build against them now.

---

## 7. Errors — one interceptor

| Code | Cause | App should |
|---|---|---|
| `401` | Missing / invalid / expired token, blocked account | Wipe the token → login. No refresh endpoint exists |
| `402` | Payment declined | Show `message`, re-enable Pay (re-initiate) |
| `404` | `Request not found` | Also returned for a request **owned by someone else** — deliberately, so ids can't be enumerated. Treat as gone |
| `409` | State conflict (already booked, already paid, can't retry yet) | Read `code` / re-read the request. Usually a navigation event, not an error toast |
| `422` | Validation | Inline field error |
| `429` | Retry cap reached | Hide Retry, offer "Book again" |

Never send a **worker** token to `/api/user/*` (or the reverse) — both families are
signed with the same secret and told apart by a `type` claim, so the server rejects
the crossover with a `401`. Keep them in separate storage keys.

---

## 8. Client sketch

```js
const BASE = 'http://16.112.64.28:4000';

// Reuse the `api()` helper from USER_AUTH_INTEGRATION_GUIDE.md §6 —
// same envelope, same 401 handling.

// ── Catalog ──
export const getServices = () => api('/api/services');

// ── Book ──
export async function book(token, { category, subcategory, jobDescription, lat, lng, address }) {
  try {
    return await api('/api/user/service-requests', {
      method: 'POST', token,
      body: { category, subcategory, jobDescription, lat, lng, address },
    });
  } catch (err) {
    // 409 hands back the live request — that's a navigation event, not a failure.
    if (err.status === 409 && err.body?.request) return { request: err.body.request, existing: true };
    throw err;
  }
}

// ── Track ──
export const getRequest = (token, id) => api(`/api/user/service-requests/${id}`, { token });
export const getActive  = (token)     => api('/api/user/service-requests/active', { token });
export const cancel     = (token, id) => api(`/api/user/service-requests/${id}/cancel`, { method: 'POST', token });
export const retry      = (token, id) => api(`/api/user/service-requests/${id}/retry`,  { method: 'POST', token });

// ── Pay: initiate → (gateway) → confirm ──
export async function pay(token, id, method = 'upi') {
  const { payment } = await api(`/api/user/service-requests/${id}/payment/initiate`, {
    method: 'POST', token, body: { method },
  });
  if (!payment) return { alreadyPaid: true };            // nothing to do

  // Real gateway: hand payment.orderId to the SDK and use what it returns.
  const gatewayReference = payment.mode === 'mock' ? undefined : await openCheckout(payment);

  return api(`/api/user/service-requests/${id}/payment/confirm`, {
    method: 'POST', token, body: { orderId: payment.orderId, gatewayReference },
  });
}

// ── Live updates ──
export function connectRealtime(token, onRequest) {
  const socket = io(BASE, { auth: { token } });
  socket.on('requests:active', ({ requests }) => requests.forEach(onRequest));
  [
    'request:searching', 'request:accepted', 'request:expired',
    'request:work_done', 'request:completed', 'request:paid', 'request:cancelled',
  ].forEach((e) => socket.on(e, ({ request }) => onRequest(request)));
  socket.on('connect_error', (err) => { if (/token|blocked|not found/i.test(err.message)) logout(); });
  return socket;
}

// ── One screen router off the request object ──
export function screenFor(r) {
  if (!r) return 'home';
  switch (r.status) {
    case 'searching':      return 'searching';                            // countdown
    case 'in_progress':    return 'tracking';                             // worker card
    case 'pending_rating': return r.payment.payable ? 'payment' : 'tracking';
    case 'completed':      return r.payment.payable ? 'payment' : 'receipt';
    case 'expired':        return r.canRetry ? 'retry' : 'noProfessionals';
    default:               return 'home';                                 // cancelled
  }
}
```

---

## 9. Screens to build

1. **Category picker** — from `GET /api/services`. Show `name`, `color`, `price`.
   Subcategory optional.
2. **Booking** — description (500-char cap) + location (map pin / GPS) + address.
   Show the price before the Book button. → `POST /api/user/service-requests`.
3. **Searching** — the countdown from `searchExpiresAt`. Show
   `"{workersNotified} professionals nearby notified"` and, as the radius grows,
   `"searching within {radiusKm} km"`. `workersNotified: 0` is normal — say
   "looking nearby", never "none found". Cancel button while `canCancel`.
4. **No professionals** — on `request:expired`. Big **Retry** when
   `canRetry`, labelled `"Retry ({attempt} of {maxAttempts})"`. When `canRetry`
   is false: "no professionals available right now" + Book again.
5. **Tracking** — the `worker` card: name, `rating` (`null` → "New"),
   `jobsCompleted`, `distanceKm`, and **call/WhatsApp buttons on `worker.phone`**.
   Waiting state until `request:work_done`.
6. **Payment** — when `payment.payable`. Method picker → initiate → confirm.
   Handle `402` inline and let them try again.
7. **Receipt / history** — from `GET /api/user/service-requests`. Show
   `payment.status` and `transactionId` on paid rows.

---

## 10. Testing it end to end

Two ready-made clients let you play both sides against a live server:

```bash
npm run dev                                        # start the API

# terminal 2 — the worker: prints offers, accept with "a <id>"
node scripts/worker-client.js <WORKER_JWT>

# terminal 3 — the customer: full REST flow + live socket events
PHONE=9876543210 npm run user-client
#   book [category] [sub] | status | retry | cancel | pay [method] | list | q
```

`scripts/user-client.js` is a working reference implementation of everything in
this guide — the countdown rendered from `searchExpiresAt`, the socket handlers,
the initiate→confirm payment pair. Read it if a payload is ambiguous.

To see the **expiry + retry** path, book a category nobody covers (e.g.
`book painting`), wait out the minute, then type `retry`. To see the **decline**
path, restart the server with `PAYMENT_FORCE_FAIL=1`.

Every OTP is `123456` in development (`SMS_MODE=mock`).

---

## 11. Not built — don't design around it

- **No customer rating of the worker.** The worker rates the *job* (1–5) to close
  it; that value isn't shown to the customer. There is no "rate your
  professional" screen to build. `customerRating` on the worker's side is a fixed
  dummy 4.6.
- **No live worker location tracking / ETA.** `worker.location` is their last
  availability heartbeat, not a stream. There's no map-follow and no ETA field.
- **No scheduled bookings.** On-demand only — the search starts immediately.
- **No dynamic pricing.** Flat rate card per category; subcategory, quantity and
  surge do nothing. `totalPrice` at creation is final.
- **No cancellation fee**, no partial payment, no tipping, no coupons, no refunds.
- **No customer wallet.** (The `TRIAL_*` wallet-cashback settings belong to the
  separate worker-trial promo, not to this flow.)
- **No chat.** Contact is the phone number revealed on acceptance.
- **No push notifications** to the customer — only the socket. If the app is
  backgrounded when a worker accepts, the customer sees it on next foreground.
  FCM would be the next addition; the server already has the hook points.
- **Retry is capped at 3 attempts per request.** After that it's a new request.

---

## 12. What changed on the backend

Full disclosure so nobody re-integrates something that didn't move.

**New files**

| File | Purpose |
|---|---|
| `src/routes/userServiceRequestRoutes.js` | The 8 customer endpoints |
| `src/controllers/userServiceRequestController.js` | Book / list / track / cancel / retry / pay |
| `src/services/paymentService.js` | Payment state machine + mock gateway + worker credit |
| `src/models/WalletTransaction.js` | Append-only worker credit ledger |
| `src/utils/requestPayload.js` | The one customer serializer (REST + socket) |
| `src/config/dispatchConfig.js` | Dispatch/timer/retry knobs, lifted out of dispatchService |
| `src/routes/catalogRoutes.js` | `GET /api/services` |
| `scripts/user-client.js` | Customer test client |

**Modified**

| File | Change |
|---|---|
| `src/models/ServiceRequest.js` | Added `user`, `attempt`, `searchStartedAt`/`searchExpiresAt`, `payment{}`, `attempt` on offers. **No change to the `status` enum** |
| `src/services/dispatchService.js` | 60s search window, wave clamped to it, `retryRequest()`, payment-due hook, customer push events |
| `src/realtime/socket.js` | Accepts user tokens → customer room + snapshot. Worker path untouched |
| `src/realtime/emitter.js` | Added `emitToUser` / `userRoom` |
| `src/controllers/serviceRequestController.js` | Now shares `requestPayload`; legacy endpoints otherwise unchanged |
| `server.js` | Mounts the two new route files |
| `.env` | `DISPATCH_SEARCH_WINDOW_SECONDS`, `DISPATCH_MAX_ATTEMPTS`, `PAYMENT_MODE`, `PAYMENT_FORCE_FAIL` |

**Untouched — the worker app needs no changes at all**

`src/utils/jobPayload.js`, `src/controllers/jobsController.js`,
`src/routes/jobsRoutes.js`, `src/services/earningsService.js`,
`src/controllers/earningsController.js`, `src/middleware/auth.js`,
`src/controllers/authController.js`, `src/controllers/profileController.js`.

Verified on the wire, not just by file: `GET /api/jobs/available` still returns
exactly `id, category, subcategory, jobDescription, address, distanceKm,
customerName, customerRating, pricing, status, offeredAt, wave`;
`GET /api/jobs/mine` still returns exactly `id, status, category, subcategory,
jobDescription, address, location, customer, customerRating, pricing, jobRating,
acceptedAt, workDoneAt, completedAt`; and `GET /api/earnings/summary` is
unchanged. No field added, none removed.

Three deliberate consequences of keeping the worker side frozen:

- **The worker's Earnings tab still derives from completed jobs, not from
  payments.** So a completed-but-unpaid job already counts toward their earnings.
  The ledger is the settlement record behind those numbers. Making earnings
  payment-aware is a worker-side change and was left out on purpose.
- **The worker is not notified when a customer pays.** That needs a new worker
  event and screen.
- **The assigned worker gets no push when a customer cancels.** They see it on
  their next `GET /api/jobs/mine`, exactly as before. (Workers still *holding an
  offer* do get it cleared — via the `job:expired` event their app already
  handles, which also fixes a pre-existing bug where cancelled requests lingered
  on their screen.)

**Legacy `POST /api/service-requests`** (unauthenticated, takes `customerName` +
`customerPhone`) still works for test scripts. It leaves `user` null, so those
requests are invisible to the customer endpoints and get no live push. The
customer app must use `/api/user/service-requests` — that's what §8 of the auth
guide was waiting on.

---

## 13. Ready-to-paste brief for Replit

> Add the service-booking flow to the Kaaryo **customer** app. Backend base URL
> `http://16.112.64.28:4000`. Auth is already built (phone + OTP, `Authorization:
> Bearer <token>`). All responses are flat JSON — `{ success, message, ...payload }`,
> no `data` wrapper; errors are `{ success: false, message }`.
>
> **The flow:** the user picks a category, describes the job and confirms a
> location. The backend notifies nearby professionals and runs a **60-second
> countdown**. If one accepts, their name/phone/rating appear and the user tracks
> the job. When the professional marks the work done, the user pays. If nobody
> accepts in 60 seconds, the user can **retry** (up to 3 attempts total).
>
> **Endpoints** (all under `/api/user/service-requests` except the catalog):
> - `GET /api/services` — no auth → `{ services: [{ key, name, color, price, currency, subcategories:[{key,name}] }] }`. Drive the category picker from this.
> - `POST /api/user/service-requests` — body `{ category, subcategory?, jobDescription, lat, lng, address? }` → `201 { request, workersNotified, searchWindowSeconds }`. **Do not send name or phone** — the server reads them from the token. `422` with `code:"PROFILE_INCOMPLETE"` → send the user to the name screen. `409` with `code:"REQUEST_IN_PROGRESS"` → the body contains the live `request`; show that screen.
> - `GET /api/user/service-requests/active` → `{ request }` or `{ request: null }`. Call on app launch to pick the screen.
> - `GET /api/user/service-requests` → `{ active:[full], history:[summary] }`.
> - `GET /api/user/service-requests/:id` → `{ request }`. Poll every 2–3s while `status === 'searching'`.
> - `POST /api/user/service-requests/:id/cancel` → `{ request }`.
> - `POST /api/user/service-requests/:id/retry` → `{ request, attempt, maxAttempts }`. Only when `canRetry`. `429` with `code:"RETRY_LIMIT_REACHED"` → hide Retry, offer Book again.
> - `POST /api/user/service-requests/:id/payment/initiate` — body `{ method }` (`upi`/`card`/`netbanking`/`wallet`/`cash`) → `{ payment: { orderId, amount, currency, mode } }`.
> - `POST /api/user/service-requests/:id/payment/confirm` — body `{ orderId }` → `{ request, workerCredited }`. Safe to retry. `402` = declined → call initiate again.
>
> **The `request` object is identical everywhere** (REST and socket). Key fields:
> `status` (`searching`/`in_progress`/`pending_rating`/`completed`/`cancelled`/`expired`),
> `categoryName`, `subcategoryName`, `jobDescription`, `totalPrice`, `currency`,
> `radiusKm`, `attempt`, `maxAttempts`, `workersNotified`, `searchExpiresAt`,
> `secondsRemaining`, `canRetry`, `canCancel`,
> `payment { status, payable, amount, method, orderId, transactionId, failureReason }`,
> and `worker { name, phone, rating, jobsCompleted, distanceKm }` once assigned.
>
> **Three rules:**
> 1. Render the countdown from `searchExpiresAt` (absolute, server-issued), not a
>    local 60s timer — it must survive backgrounding.
> 2. Show buttons from `payment.payable`, `canRetry` and `canCancel`. Do not
>    re-derive them from `status`.
> 3. `workersNotified: 0` is not an error. Show "looking for a professional
>    nearby" — the search radius widens automatically.
>
> **Live updates (optional but preferred):** `socket.io-client` to the same base
> URL with `{ auth: { token } }`. Read-only events, each `{ request }`:
> `requests:active` (snapshot of live requests on connect), `request:searching`,
> `request:accepted`, `request:expired`, `request:work_done`, `request:completed`,
> `request:paid`, `request:cancelled`. Re-render from the `request` in the payload.
> Everything works with polling alone if you skip this.
>
> **Screens:** category picker → booking form → searching (countdown) → no
> professionals (Retry) → tracking (worker card + call button) → payment →
> receipt/history.
>
> **Do not build:** customer→worker ratings, live worker location or ETA,
> scheduled bookings, coupons, tipping, refunds, a customer wallet, or in-app
> chat. None are supported by the backend.
