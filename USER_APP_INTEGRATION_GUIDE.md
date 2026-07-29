# Kaaryo — User (Customer) App Integration Guide

Everything the **user-facing app** needs from this backend: endpoints, payloads, the
live status flow, and the real-time story.

> **Read this first — the two facts that shape the whole app**
>
> 1. **There is no customer socket.** The Socket.IO channel in this backend is
>    worker-only and rejects any connection that isn't carrying a valid *worker*
>    JWT. The user app tracks a request by **polling `GET /api/service-requests/:id`**.
> 2. **There is no customer auth.** The three customer endpoints are open — the
>    request is identified by the `id` returned at creation. The user app must
>    persist that `id` locally, because there is no "list my requests" endpoint.
>
> Both are deliberate ("the customer app isn't built yet") and both are fixable
> server-side — see [Gaps](#7-gaps--what-to-add-server-side) at the end. Build
> against what exists today; the polling design keeps working even after sockets
> are added.

---

## 1. Connection basics

| Item | Value |
|---|---|
| Base URL (local) | `http://16.112.64.28:4000` (`PORT` in `.env`) |
| Content type | `application/json` |
| Auth | **none** for customer endpoints |
| CORS | fully open (`origin: *`) — browser/Expo calls work directly |

### Response envelope

Every response, success or failure, is a flat JSON object with a `success` boolean
and a human-readable `message`. Payload fields sit **at the top level**, not nested
under a `data` key.

Success:
```json
{ "success": true, "message": "Request status", "request": { "...": "..." } }
```

Failure:
```json
{ "success": false, "message": "A valid 10-digit customerPhone is required" }
```

Always branch on `success` (or the HTTP status), then read the named field
(`request`, `workersNotified`, …).

---

## 2. The user app's API surface

Exactly **three** customer endpoints exist, plus two public helpers.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/service-requests` | Book a service — creates the request and fires dispatch |
| `GET` | `/api/service-requests/:id` | Poll live status (the heart of the app) |
| `POST` | `/api/service-requests/:id/cancel` | Cancel |
| `GET` | `/api/places/cities` | Operating cities |
| `GET` | `/api/places/suggest?city=&q=` | Locality autosuggest |

Nothing else in this backend is customer-facing. `/api/auth/*`, `/api/profile/*`,
`/api/jobs/*`, `/api/onboarding/*`, `/api/worker/*` and `/api/admin/*` all belong
to the worker app or the admin panel. **Do not call `/api/auth/send-otp` from the
user app** — verifying an OTP there creates a *Worker* record for that phone
number, which would pollute the worker pipeline.

---

### 2.1 `POST /api/service-requests` — book a service

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `customerName` | string | ✅ | Non-empty after trim |
| `customerPhone` | string | ✅ | Exactly 10 digits |
| `category` | string | ✅ | One of the 8 category keys (§3) |
| `subcategory` | string | ➖ | Must be valid *for that category*; omit or `null` |
| `jobDescription` | string | ✅ | Free text, **max 500 chars**. Shown verbatim to the worker |
| `lat` | number | ✅ | −90…90 |
| `lng` | number | ✅ | −180…180 |
| `address` | string | ➖ | Human-readable address; defaults to `""` |
| `radiusKm` | number | ➖ | Overrides the initial 3 km search radius |

```json
{
  "customerName": "Adarsh Kumar",
  "customerPhone": "9876543210",
  "category": "cleaning",
  "subcategory": "kitchen",
  "jobDescription": "Kitchen deep clean, chimney and slab included. 2BHK.",
  "lat": 12.9352,
  "lng": 77.6245,
  "address": "3rd Block, Koramangala, Bengaluru"
}
```

**`201` response**

```json
{
  "success": true,
  "message": "Request created — notified 4 nearby worker(s). Waiting for someone to accept.",
  "request": {
    "id": "66a1f0c9e4b0a1234567890a",
    "status": "searching",
    "category": "cleaning",
    "subcategory": "kitchen",
    "jobDescription": "Kitchen deep clean, chimney and slab included. 2BHK.",
    "totalPrice": 300,
    "currency": "INR",
    "address": "3rd Block, Koramangala, Bengaluru",
    "location": { "type": "Point", "coordinates": [77.6245, 12.9352] },
    "radiusKm": 3,
    "wave": 1,
    "workersNotified": 4,
    "createdAt": "2026-07-29T10:15:00.000Z"
  },
  "workersNotified": 4
}
```

`workersNotified: 0` is **not an error** — it means nobody eligible was online
within 3 km yet. The backend auto-expands the radius. Show "finding a
professional near you", not a failure.

**Persist `request.id` immediately** (AsyncStorage / localStorage). It is the only
handle to the request; losing it means the user cannot see or cancel their booking.

**Errors** — all `422` with a specific `message`:
`customerName is required` · `A valid 10-digit customerPhone is required` ·
`Invalid service category: <x>` · `Invalid subcategory "<y>" for category "<x>"` ·
`jobDescription is required` · `jobDescription must be under 500 characters` ·
`Valid numeric lat and lng are required`.

Coordinates are coerced with `Number()`, so `"12.9352"` as a string is accepted;
send real numbers anyway.

---

### 2.2 `GET /api/service-requests/:id` — poll status

The single most important call in the app. Response shape **grows as the status
advances**.

Always present:

```json
{
  "success": true,
  "message": "Request status",
  "request": {
    "id": "66a1f0c9e4b0a1234567890a",
    "status": "searching",
    "category": "cleaning",
    "subcategory": "kitchen",
    "jobDescription": "...",
    "totalPrice": 300,
    "currency": "INR",
    "address": "3rd Block, Koramangala, Bengaluru",
    "location": { "type": "Point", "coordinates": [77.6245, 12.9352] },
    "radiusKm": 6,
    "wave": 2,
    "workersNotified": 9,
    "createdAt": "2026-07-29T10:15:00.000Z"
  }
}
```

`radiusKm`, `wave` and `workersNotified` are live search telemetry — great for a
"searching" screen ("expanding search to 6 km · 9 professionals notified").
`workersNotified` is cumulative across waves, not the count currently deciding.

Once `status` is `in_progress`, `pending_rating` or `completed`, a `worker` object
and `acceptedAt` appear:

```json
{
  "request": {
    "id": "66a1f0c9e4b0a1234567890a",
    "status": "in_progress",
    "totalPrice": 300,
    "currency": "INR",
    "worker": {
      "id": "66a1e5b2e4b0a12345678111",
      "name": "Ramesh Kumar",
      "phone": "9812345678",
      "rating": 4.7,
      "jobsCompleted": 132,
      "distanceKm": 1.4
    },
    "acceptedAt": "2026-07-29T10:15:37.000Z"
  }
}
```

The worker's **phone is deliberately withheld until acceptance** — that's the
"call your professional" unlock moment in the UI.

Terminal timestamps, added per status: `completedAt` (completed) ·
`cancelledAt` (cancelled) · `expiredAt` (expired).

**Errors:** `404 { "success": false, "message": "Request not found" }`. A
malformed id (not a valid Mongo ObjectId) currently surfaces as a **`500`** with a
CastError message — treat any non-200 on this endpoint as "request unavailable".

---

### 2.3 `POST /api/service-requests/:id/cancel`

No body. Returns `200` with the updated `request` (`status: "cancelled"`,
`cancelledAt` set). Frees the assigned worker if one had accepted.

| Code | `message` | Meaning |
|---|---|---|
| `404` | `Request not found` | Bad id |
| `409` | `Work is already done for this job — it just needs the worker's rating to finalize, so it can no longer be cancelled` | Status was `pending_rating` |
| `409` | `Request already completed` / `cancelled` / `expired` | Terminal |

**Hide the cancel button** whenever `status` is not `searching` or `in_progress`.
Cancelling is allowed *after* a worker accepted — decide whether your UX wants a
confirmation dialog there ("Ramesh is on the way").

---

### 2.4 Places helpers

`GET /api/places/cities` →
```json
{ "success": true, "message": "Operating cities",
  "cities": ["Bengaluru", "Mumbai", "Delhi", "Pune", "Hyderabad"] }
```

`GET /api/places/suggest?city=Bengaluru&q=kor` →
```json
{ "success": true, "message": "Locality suggestions", "suggestions": ["Koramangala"] }
```

`city` is required (`422` otherwise). Both are **mock** today (`PLACES_MODE=mock`)
— a canned list of ~6 localities per city, substring-filtered. They do **not**
return coordinates, so they cannot supply the `lat`/`lng` that
`POST /api/service-requests` requires. Get coordinates from the device GPS or a
map picker; use these endpoints only for the city dropdown and a text hint.

---

## 3. Service catalog (hardcode this in the app)

The catalog lives at `GET /api/profile/catalog`, but that route sits behind a
**worker JWT**, so the user app can't read it. Mirror it client-side — these keys
are validated server-side on booking, so they must match exactly.

| Category key | Name | Colour | Price (INR) | Subcategory keys |
|---|---|---|---|---|
| `cleaning` | Cleaning | `#3b82f6` | 300 | `basic_home`, `kitchen`, `bathroom`, `deep_cleaning`, `sofa_carpet`, `office_commercial`, `post_construction` |
| `electrical` | Electrical | `#f59e0b` | 400 | `wiring`, `fan_installation`, `switch_socket`, `appliance_repair`, `lighting` |
| `cooking` | Cooking | `#ef4444` | 350 | `north_indian`, `south_indian`, `tiffin_service`, `party_cooking` |
| `plumbing` | Plumbing | `#8b5cf6` | 450 | `tap_repair`, `pipe_fitting`, `drainage`, `water_tank` |
| `carpentry` | Carpentry | `#a16207` | 500 | `furniture_repair`, `door_window`, `modular_furniture`, `polishing` |
| `ac_repair` | AC Repair | `#0ea5e9` | 600 | `installation`, `servicing`, `gas_refill`, `uninstallation` |
| `painting` | Painting | `#10b981` | 800 | `interior`, `exterior`, `texture`, `waterproofing` |
| `pest_control` | Pest Control | `#14b8a6` | 500 | `cockroach`, `termite`, `rodent`, `mosquito` |

**Pricing is a flat per-category rate card** (env-tunable, no surge, no
item-level quoting). Prices above are the current `.env` values. Since the app
can't read them from the API, either hardcode them as *indicative* ("from ₹300")
or — better — show the authoritative `totalPrice` returned by the create call
before asking for confirmation. The subcategory does **not** change the price.

The user is only ever shown `totalPrice`. The platform-fee / worker-earning split
on the request is internal and is already stripped out of the customer payload.

---

## 4. Real-time: what actually exists

### 4.1 Sockets are worker-only

`src/realtime/socket.js` runs one Socket.IO namespace whose middleware verifies
`handshake.auth.token` as a **worker** JWT and rejects everything else
(`Auth token missing` / `Invalid or expired token`). Each worker joins a private
room `worker:<workerId>`; the dispatch engine pushes `job:offer`, `job:taken`,
`job:expired` and an on-connect `jobs:open` snapshot into those rooms. There is no
`customer:<id>` room and no customer event anywhere in the codebase.

**Do not attempt a socket connection from the user app.** It will be rejected at
the handshake. Everything below is the polling contract that replaces it.

### 4.2 Polling contract

```
POST /api/service-requests  →  store request.id
      ↓
poll GET /api/service-requests/:id
      ↓  status === 'searching'      every 3 s   (search screen)
      ↓  status === 'in_progress'    every 10 s  (job-live screen)
      ↓  status === 'pending_rating' every 15 s  (work-done screen)
      ↓  terminal                    stop polling
```

Rules that keep this cheap and correct:

- **Stop on terminal states** — `completed`, `cancelled`, `expired`. Never keep a
  timer alive after that.
- **Pause when backgrounded**, resume with an immediate fetch on foreground. A
  status change can easily happen while the app is hidden.
- **Cap the searching phase.** Worst case a request stays `searching` for
  ~150–180 s before the backend expires it (see §5). Poll for up to ~4 minutes,
  then re-fetch once and trust whatever status you get.
- **Never infer status locally.** The server is the only authority — a worker can
  accept, the sweeper can expire, and the customer can cancel, all concurrently.
- Use one shared poller keyed by `requestId`, not one per mounted screen.

```js
// Minimal, framework-agnostic poller.
const TERMINAL = ['completed', 'cancelled', 'expired'];
const INTERVAL = { searching: 3000, in_progress: 10000, pending_rating: 15000 };

export function trackRequest(baseUrl, requestId, onUpdate, onError) {
  let timer = null;
  let stopped = false;

  async function tick() {
    if (stopped) return;
    try {
      const res = await fetch(`${baseUrl}/api/service-requests/${requestId}`);
      const body = await res.json();
      if (!body.success) throw new Error(body.message || 'Request unavailable');

      onUpdate(body.request);
      if (TERMINAL.includes(body.request.status)) return stop();
      timer = setTimeout(tick, INTERVAL[body.request.status] ?? 10000);
    } catch (err) {
      onError?.(err);
      timer = setTimeout(tick, 8000); // backoff, keep trying
    }
  }

  function stop() { stopped = true; if (timer) clearTimeout(timer); }

  tick();
  return stop; // call on unmount / cancel
}
```

### 4.3 If you want true real-time later

The server-side change is small and the app shouldn't be architected around its
absence. Sketch, for whoever adds it:

1. Add a `customer:<requestId>` room; let a socket join it by presenting the
   `requestId` (no account needed — the id is already the bearer secret).
2. Emit from `dispatchService` at the three moments that already mutate state:
   `acceptRequest` → `request:accepted` (worker card), `markWorkDone` →
   `request:work_done`, `rateJob` → `request:completed`, plus `expire` →
   `request:expired` and each `dispatchWave` → `request:searching`
   (`{ radiusKm, wave, workersNotified }`).
3. Reuse `emitter.js` — it's already a decoupled, io-holder shim.

Build the app so the poller is one swappable module (like `trackRequest` above).
Then adding sockets is a drop-in replacement, not a rewrite.

---

## 5. The dispatch flow the UI is narrating

What happens on the backend between "Book" and "Ramesh accepted":

1. **Wave 1** — the request is broadcast to the **10 nearest eligible workers**
   within **3 km**. Eligible = `approved` status, currently **online**, has the
   requested category/subcategory in their expertise, is **not already on a job**,
   and the job is within *their own* declared travel radius.
2. Each notified worker gets a live `job:offer` push (plus a mock SMS/push
   fallback). A **30 s** wave timer starts.
3. **First to accept wins**, enforced by one atomic conditional DB update. Everyone
   else instantly sees the job vanish. Status → `in_progress`, worker phone unlocks.
4. If nobody accepts in 30 s, a sweeper (running every 5 s) **expands the radius by
   3 km** and broadcasts a fresh wave to newly-in-range workers. `wave` increments,
   `radiusKm` grows: 3 → 6 → 9 → 12 → **15 km max**.
5. At 15 km with no new workers found, the request **expires**.

So: ~5 waves × 30 s ≈ **150–180 s** of searching before expiry, and `workersNotified`
climbs monotonically across waves. All five numbers are env-tunable
(`DISPATCH_*` in `.env`) — don't hardcode "3 km" or "30 seconds" as copy in the app;
render `radiusKm` from the response.

### Status machine (customer-visible)

| `status` | What happened | Suggested user-facing copy | Cancel? |
|---|---|---|---|
| `searching` | Offers out, nobody accepted yet | "Finding a professional near you… (searching within {radiusKm} km)" | ✅ |
| `in_progress` | A worker accepted; work ongoing | "{worker.name} accepted your booking" → call/track | ✅ |
| `pending_rating` | Worker marked the work **done**; awaiting the worker's own rating | **"Work completed"** — see the warning below | ❌ |
| `completed` | Worker submitted their rating; job closed | "Job completed — ₹{totalPrice}" | ❌ |
| `cancelled` | Customer cancelled | "Booking cancelled" | ❌ |
| `expired` | No worker accepted within 15 km | "No professionals available right now — please try again" + a Rebook button | ❌ |

> ⚠️ **`pending_rating` is an internal name, not a user-facing one.** It means *the
> work is finished* and the backend is waiting for the **worker** to submit their
> 1–5 rating of the job. Never show the user "pending rating" — they'd think the
> app is waiting on *them*, and there is no customer rating endpoint to satisfy it.
> Render `pending_rating` and `completed` as the same "Work completed" screen; the
> only difference the user might notice is that `completedAt` appears on the latter.

---

## 6. Screen-by-screen build order

A minimal, shippable v1 that uses only what exists:

1. **Onboarding / name + phone** — local only. No signup API exists; collect
   `customerName` + `customerPhone` once and store them on the device. If you want
   OTP verification, it must be built server-side first (§7) — do **not** reuse
   `/api/auth/*`.
2. **Category grid** — 8 cards from the hardcoded catalog (§3), with the colours.
3. **Subcategory picker** — optional step; only the listed keys for that category.
4. **Job details** — free-text `jobDescription` with a live 500-char counter.
5. **Location** — device GPS or map pin → `lat`/`lng`; reverse-geocode or let the
   user type the `address` string. `/api/places/*` fills the city dropdown only.
6. **Review & confirm** — show the indicative price, then `POST` and show the
   authoritative `totalPrice` from the response.
7. **Searching screen** — start the poller. Animate on `radiusKm` / `wave` /
   `workersNotified`. Cancel button. Handle `expired` with a Rebook CTA.
8. **Job-live screen** — worker card (name, `rating`, `jobsCompleted`,
   `distanceKm`), a **Call** button on `worker.phone`, cancel with confirmation.
9. **Completion screen** — on `pending_rating` / `completed`, show "Work completed"
   and the amount payable. Payment is **cash/offline** — there is no payment API.
10. **Local history** — keep the array of `{ id, category, createdAt }` on-device
    and re-fetch each by id. There is no server-side "my bookings" endpoint.

### Deliberately absent from v1 (don't design around them)

- **Live worker location on a map.** The API returns the worker's `distanceKm` at
  acceptance only. `currentLocation` is fetched server-side but not exposed in the
  customer payload, and there's no worker→customer location stream. Show a static
  distance, not a moving pin.
- **Customer rates the worker.** Only the *worker* rates the job. The
  `customerRating` on a request is a hardcoded placeholder (`4.6`) shown to the
  worker pre-accept.
- **In-app payments, wallet, coupons, scheduling for later, saved addresses,
  multi-item carts, chat.** None have endpoints.
- **Push notifications to the customer.** `notificationService` targets workers only.

---

## 7. Gaps → what to add server-side

Ordered by how much they hurt the user app. Each is a small, additive change that
does **not** alter the dispatch engine.

| # | Gap | Why it matters | Sketch |
|---|---|---|---|
| 1 | **No customer auth** | Anyone with a request id can read a customer's name, address and the worker's phone, or cancel the job. Ids are unguessable but permanent. | A `Customer` model + `/api/customer/auth/*` OTP flow reusing the `Otp` model and `smsService`; a `customerAuth` middleware; scope the three routes to the owner. Keep it separate from `authController`, which creates *Workers*. |
| 2 | **No "my bookings" list** | History dies with the device's local storage. | `GET /api/customer/requests` once #1 exists — or, interim, `GET /api/service-requests?phone=&limit=` (needs #1's protection to be safe). |
| 3 | **No public catalog + price endpoint** | Prices are env-tunable but the app has them hardcoded, so they silently drift out of sync. | Expose `GET /api/catalog` (unauthenticated) returning `SERVICE_CATALOG` merged with `CATEGORY_BASE_PRICE` from `pricingService`. |
| 4 | **No customer real-time** | Polling costs battery and adds up to 3 s of latency to "worker accepted". | §4.3. |
| 5 | **`pending_rating` is worker-blocking** | The job hangs in a non-terminal state until the *worker* rates it; the customer's screen can't move to `completed`. | Either auto-complete on a timer, or add a customer-visible alias so the app doesn't depend on this internal state. |
| 6 | **No customer rating of the worker** | One-sided quality signal; `worker.rating` has no customer input. | `POST /api/service-requests/:id/rate` writing a `customerToWorkerRating`, then recompute `Worker.rating`. |
| 7 | **Bad ObjectId → `500`** | The app can't distinguish "not found" from "server broken". | Add a `CastError → 404` branch in `errorHandler`, or validate with `mongoose.isValidObjectId` in the controller. |
| 8 | **Places mock returns no coordinates** | The locality picker can't drive booking. | Implement `PLACES_MODE=real` (Google Places Autocomplete + Place Details for lat/lng) in `placesService`. |

---

## 8. Related: the trial-feedback web form

Not part of the user app, but customer-facing and easy to confuse with it. A
worker's qualification "trial job" is done at a real customer's home, and that
customer submits 10 feedback answers via a **signed one-time link** (`GET`/`POST
/api/public/trial-feedback/:token`) sent over SMS. It's token-gated, accountless,
and stands in for the missing customer app. If you later want that form *inside*
the user app, the token in the deep link is the only credential needed —
`TRIAL_JOB_GUIDE.md` has the question set and decision engine.

---

## 9. Ready-to-paste brief for Replit

> Build a mobile app (React Native / Expo) for **Kaaryo**, an on-demand home-services
> marketplace — this is the **customer** app. Backend base URL: `<BASE_URL>`.
>
> **API — only these endpoints exist, and none require auth:**
> - `POST /api/service-requests` — body `{ customerName, customerPhone (10 digits),
>   category, subcategory?, jobDescription (≤500 chars), lat, lng, address?, radiusKm? }`
>   → `201 { success, message, request, workersNotified }`. Store `request.id` locally.
> - `GET /api/service-requests/:id` → `{ success, message, request }`. Poll this.
> - `POST /api/service-requests/:id/cancel` (no body) → `{ success, message, request }`.
> - `GET /api/places/cities` → `{ cities: [...] }`.
> - `GET /api/places/suggest?city=&q=` → `{ suggestions: [...] }`.
>
> Every response is flat: `{ success, message, ...payload }`. Errors are
> `{ success: false, message }` with status 422 (validation), 404 (not found),
> 409 (conflict).
>
> **There is NO WebSocket and NO login.** Track a booking by polling
> `GET /api/service-requests/:id`: every 3 s while `status === "searching"`,
> every 10 s while `in_progress`, every 15 s while `pending_rating`, and **stop**
> on `completed` / `cancelled` / `expired`. Pause polling when the app is
> backgrounded; re-fetch immediately on foreground. Put the poller in one
> swappable module so a socket can replace it later.
>
> **Statuses and copy:** `searching` → "Finding a professional near you (searching
> within {radiusKm} km · {workersNotified} notified)" + Cancel · `in_progress` →
> worker card (`worker.name`, `rating`, `jobsCompleted`, `distanceKm`) with a Call
> button on `worker.phone`, Cancel with confirmation · `pending_rating` **and**
> `completed` → the same "Work completed — ₹{totalPrice}" screen (never show the
> words "pending rating"; it refers to the *worker's* action, not the user's) ·
> `cancelled` → "Booking cancelled" · `expired` → "No professionals available right
> now" + Rebook. Only `searching` and `in_progress` may show a Cancel button.
>
> **Categories are hardcoded** (the catalog endpoint is worker-only). Keys, names,
> colours and indicative prices: cleaning `#3b82f6` ₹300 · electrical `#f59e0b`
> ₹400 · cooking `#ef4444` ₹350 · plumbing `#8b5cf6` ₹450 · carpentry `#a16207`
> ₹500 · ac_repair `#0ea5e9` ₹600 · painting `#10b981` ₹800 · pest_control
> `#14b8a6` ₹500. Subcategory keys are listed in §3 of the integration guide and
> must match exactly. Subcategory does not affect price; show the authoritative
> `totalPrice` from the create response before confirming.
>
> **Screens:** (1) local name+phone capture, no signup API; (2) 8-category grid;
> (3) subcategory picker; (4) job description with 500-char counter; (5) location
> via GPS/map pin producing `lat`/`lng` + a typed `address`; (6) review & confirm;
> (7) searching screen with the live poller; (8) job-live screen; (9) completion
> screen (payment is **cash/offline** — no payment API); (10) local booking history
> re-fetched by stored id (no server-side list endpoint).
>
> **Do NOT build:** live worker tracking on a map (no location stream — show
> `distanceKm` only), customer-rates-worker, in-app payments/wallet/coupons,
> scheduled bookings, saved addresses, chat, or push notifications. No endpoints
> exist for any of them. Also do not call `/api/auth/*` — that is the worker OTP
> flow and it creates worker accounts.
