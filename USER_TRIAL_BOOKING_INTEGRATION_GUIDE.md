# Kaaryo — Discounted Trial Booking Integration Guide (Customer App)

A **trial job** is the last filter in worker onboarding: a trainee cleaner does one
subsidised job, and the customer's feedback decides whether they get approved.
Until now only the admin dashboard could create one. This guide covers the
customer-app flow that lets a user book one themselves at a discount.

For the user it's a cheap cleaning job. For the platform it's how the trial queue
actually gets cleared. **The customer's feedback form is the step that onboards
the worker** — that's the whole point of the flow, and worth saying on the screen.

Base URL: `http://16.112.64.28:4000` (`PORT` in `.env`).


> ### Read this first — two things that catch people out
>
> **1. Trial statuses are NOT service-request statuses.** A trial uses
> `assigned` / `accepted` / `in_progress` / `completed` / `declined` / `expired`.
> There is no `searching` and no `pending_rating`. If you reuse the switch from
> the normal booking flow, every screen will route wrong. §5 maps them.
>
> **2. Cleaning only.** Electricians never do a trial job — they sit an in-person
> assessment at a partner shop instead — so there is no electrical trial to book.
> `category` is fixed server-side; sending `category: "electrical"` is a `422`,
> not a silent substitution.
>
> **3. Live tracking was added later.** The `trial` payload now also carries a
> composed `stage` — the *same* vocabulary a normal booking uses, precisely so
> one map component serves both — plus a live `worker.location` / `etaMinutes` /
> `arrivalStatus` while the trainee travels, and `trial:location` /
> `trial:arriving_soon` / `trial:arrived` socket events. All additive; the status
> mapping in §5 is unchanged. See **USER_APP_LIVE_TRACKING_GUIDE.md** §6.

---

## 1. Pricing — the whole offer in four numbers

| | Amount | Where it comes from |
|---|---|---|
| Base price (what the job is worth) | **₹110** | `pricing.basePrice` — show struck through |
| Customer pays | **₹100** | `pricing.userPrice` |
| Reward credited back | **₹40** | `pricing.rewardAmount` (40% of what they paid) |
| Effective cost to the customer | **₹60** | `pricing.netCost` |

And the part the customer never sees: **the worker keeps the full ₹100.** There is
no platform commission on a trial. The platform collects ₹100, pays the worker
₹100 and hands ₹40 back — a deliberate ₹40 loss per trial, which is why the offer
is capped per account (§3).

Never hardcode these. All four come from `GET /api/user/trials/offer` and are
env-tunable server-side (`TRIAL_BASE_PRICE`, `TRIAL_USER_PRICE`,
`TRIAL_REWARD_PERCENT`). Suggested copy:

> **Try Kaaryo for ₹100** ~~₹110~~
> Get ₹40 back as a reward · effectively ₹60
> You'll be matched with a professional completing their onboarding — your
> feedback helps them get approved.

The reward lands in the customer's wallet **when they pay**, not when the job is
booked or approved.

---

## 2. The flow in one picture

```
┌─ Home ──────────────────────────────────────────────────────────┐
│  GET /api/user/trials/offer   → available? price? allowance?     │
│  available === false → hide the card (or show `reason`)          │
├─ Trial booking screen ──────────────────────────────────────────┤
│  subcategory (optional) + description + location                │
│         ↓                                                       │
│  POST /api/user/trials                                          │
│         ↓  201 → status:'assigned', candidateCount:3            │
├─ Searching screen ──── up to 3 × 90s ───────────────────────────┤
│  ONE trainee at a time gets a 90s offer, nearest first.         │
│  Declines / no answer → rolls to the next automatically.        │
│  socket: trial:searching { candidateNumber, candidateCount }    │
│         ↓                                                       │
│    ┌──────────────────────────┬────────────────────────────┐    │
│    │ someone accepted         │ all 3 passed / timed out   │    │
│    │ trial:accepted           │ trial:no_workers           │    │
│    │ status:'accepted'        │ status:'declined'|'expired' │    │
│    │         ↓                │      canRetry === true     │    │
│    │                          │         ↓                  │    │
│    │                          │  POST .../:id/retry        │    │
│    └──────────────────────────┴────────────────────────────┘    │
├─ Tracking ──────────────────────────────────────────────────────┤
│  worker card (name, phone, isTrainee) · status:'in_progress'     │
│  worker marks the work done in THEIR app                         │
│         ↓  socket: trial:feedback_requested                      │
│  status:'completed' → payment.payable + feedbackPending          │
├─ Pay ───────────────────────────────────────────────────────────┤
│  POST .../:id/payment/initiate { method }  → orderId            │
│  POST .../:id/payment/confirm  { orderId } → paid + ₹40 reward  │
├─ Rate (this onboards the worker) ───────────────────────────────┤
│  GET  .../:id/feedback-form   → 10 questions                    │
│  POST .../:id/feedback        → { outcome: { workerApproved } }  │
└─────────────────────────────────────────────────────────────────┘
```

Payment and feedback both unlock at `completed` and are **independent** — neither
blocks the other. Prompt for payment first (money is time-sensitive), but never
gate the feedback form behind it: that form is what decides a real person's
onboarding.

---

## 3. Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/user/trials/offer` | Can I book? At what price? — **call before showing the card** |
| `POST` | `/api/user/trials` | Book → starts the trainee search |
| `GET` | `/api/user/trials` | `active` + `history` |
| `GET` | `/api/user/trials/active` | The one live booking — call on app launch |
| `GET` | `/api/user/trials/:id` | Poll one booking |
| `POST` | `/api/user/trials/:id/cancel` | Cancel |
| `POST` | `/api/user/trials/:id/retry` | Search again after nobody accepted |
| `POST` | `/api/user/trials/:id/payment/initiate` | `{ method }` → `orderId` |
| `POST` | `/api/user/trials/:id/payment/confirm` | `{ orderId }` → paid **+ reward credited** |
| `GET` | `/api/user/trials/:id/feedback-form` | The 10 questions |
| `POST` | `/api/user/trials/:id/feedback` | `{ answers }` → **onboards the worker** |
| `GET` | `/api/user/wallet` | Reward balance + statement |

Every trial endpoint returns the same `trial` object (§5), and so does every
`trial:*` socket event. One parser, one renderer.

---

### 3.1 `GET /api/user/trials/offer`

Gate the entry point on this. It answers "should this customer see a trial card at
all, and what does it say?" in one call.

```json
{
  "success": true,
  "message": "Discounted trial available",
  "available": true,
  "reason": null,
  "code": null,
  "liveTrialId": null,
  "used": 0,
  "allowance": 1,
  "category": "cleaning",
  "categoryName": "Cleaning",
  "subcategories": [
    { "key": "basic_home", "name": "Basic home cleaning" },
    { "key": "kitchen", "name": "Kitchen cleaning" },
    { "key": "bathroom", "name": "Bathroom cleaning" },
    { "key": "deep_cleaning", "name": "Deep cleaning" },
    { "key": "sofa_carpet", "name": "Sofa / carpet cleaning" },
    { "key": "office_commercial", "name": "Office / commercial cleaning" },
    { "key": "post_construction", "name": "Post-construction cleaning" }
  ],
  "pricing": {
    "currency": "INR",
    "basePrice": 110, "userPrice": 100,
    "userSavings": 10, "userDiscountPercent": 9,
    "rewardPercent": 40, "rewardAmount": 40,
    "netCost": 60
  },
  "offerWindowSeconds": 90
}
```

Always `200`. When `available` is `false`, `reason` is display-ready text and
`code` says why:

| `code` | Meaning | App should |
|---|---|---|
| `TRIAL_IN_PROGRESS` | They already have a live booking (`liveTrialId` is set) | Show "resume your trial" → navigate to that id |
| `TRIAL_ALLOWANCE_USED` | Lifetime cap spent (`used >= allowance`) | Hide the card, or show it disabled with `reason` |
| `TRIAL_DISABLED` | Feature switched off server-side | Hide the card |

`allowance` is **1 by default** — one discounted trial per account, because each
one costs the platform ₹40. Read it from here rather than assuming; raising it is
a server config change (`USER_TRIAL_MAX_PER_USER`).

---

### 3.2 `POST /api/user/trials`

```json
{
  "subcategory": "kitchen",
  "jobDescription": "Kitchen deep clean — two-burner hob and the chimney.",
  "lat": 17.4165711,
  "lng": 78.4333269,
  "address": "Flat 402, Hitech City, Hyderabad",
  "scheduledTime": "2026-08-02T10:00:00.000Z"
}
```

| Field | Required | Notes |
|---|---|---|
| `subcategory` | no | A `key` from the offer's `subcategories` |
| `jobDescription` | yes | ≤ 500 chars, shown verbatim to the trainee |
| `lat` / `lng` | yes | Numbers |
| `address` | no | Free text |
| `scheduledTime` | no | ISO date. Omit for "as soon as possible" |

**Do not send `category`** (fixed to cleaning), and **do not send name or phone** —
they come from the authenticated account, because the trainee sees them.

`201` → the search has started and the first trainee already has the offer:

```json
{
  "success": true,
  "message": "Trial booked — asking a nearby trainee professional to accept (up to 3 will be tried in turn).",
  "candidateCount": 3,
  "offerWindowSeconds": 90,
  "trial": { "id": "...", "status": "assigned", "...": "see §5" }
}
```

Errors:

| Code | `code` | App should |
|---|---|---|
| `409` | `NO_TRIAL_WORKERS` | **The most common one.** No trainee is waiting near them. Show "not available in your area right now" + offer a regular booking. Nothing was created — no id to retry |
| `409` | `TRIAL_IN_PROGRESS` | Body contains the live `trial` — navigate to it |
| `403` | `TRIAL_ALLOWANCE_USED` | Cap spent |
| `422` | `TRIAL_CATEGORY_NOT_SUPPORTED` | You sent a non-cleaning `category`. Drop the field |
| `422` | `PROFILE_INCOMPLETE` | Send them to the name screen, then re-submit |
| `422` | — | Validation (`jobDescription`, coords, bad subcategory) |

`NO_TRIAL_WORKERS` is a normal outcome, not an error state — trial supply is
inherently thin (it's however many trainees happen to be mid-onboarding nearby).
Design that screen properly; don't leave it as a toast.

---

### 3.3 `GET /api/user/trials/active` · `GET /api/user/trials/:id` · `GET /api/user/trials`

`/active` returns `{ trial }` or `{ trial: null }` — call it on launch to pick the
screen. It includes a `completed` trial whose **feedback is still outstanding**,
because that form is the thing most easily lost across an app restart.

`/` returns `{ active: [full], history: [summary] }`. History rows are compact:

```json
{
  "id": "...", "type": "trial", "status": "completed",
  "category": "cleaning", "subcategory": "kitchen",
  "userPrice": 100, "currency": "INR",
  "rewardAmount": 40, "rewardCredited": true,
  "paymentStatus": "paid", "feedbackSubmitted": true,
  "canRetry": false, "createdAt": "...", "completedAt": "..."
}
```

---

### 3.4 `POST /api/user/trials/:id/cancel`

No body. Allowed while `assigned`, `accepted` or `in_progress` (`canCancel`).
Once `completed` it's refused (`409`) — the work is done and a real person's
onboarding is waiting on the feedback.

The trainee is returned to the trial queue, so cancelling doesn't cost them their
onboarding. It also **doesn't consume the customer's allowance** — they got no
service.

---

### 3.5 `POST /api/user/trials/:id/retry`

No body. Valid when `canRetry` is `true` (status `declined` or `expired`, i.e. the
whole candidate queue passed). Keeps the same trial id — the app holds its screen
and subscription — and rebuilds the queue from a **fresh** search, since the point
of retrying is that available supply has changed.

Anyone who explicitly **declined** this booking is excluded from the retry; a
timeout is forgiven (their phone may simply have been away).

```json
{
  "success": true,
  "message": "Searching again — asking up to 2 trainee professional(s).",
  "candidateCount": 2,
  "trial": { "status": "assigned", "searchAttempt": 2, "...": "..." }
}
```

`409 NO_TRIAL_WORKERS` if there's still nobody. Unlike normal bookings there is
**no retry cap** — a retry costs the platform nothing until someone accepts.

---

### 3.6 Payment — `initiate` then `confirm`

Identical contract to the normal booking flow, so **reuse that payment screen**.
Requires `payment.payable === true`.

```
POST /api/user/trials/:id/payment/initiate   { "method": "upi" }
  → { trial, payment: { orderId, amount: 100, currency, method, provider, mode } }

POST /api/user/trials/:id/payment/confirm    { "orderId": "order_..." }
  → { trial, rewardCredited: true, rewardAmount: 40 }
```

`method` ∈ `upi` | `card` | `netbanking` | `wallet` | `cash`.
In `mode: "mock"` there is no gateway SDK — go straight to `confirm`.

**The reward is credited inside `confirm`**, in the same call. `rewardCredited`
tells you whether this call was the one that created it (`false` on a repeat).
Safe to retry: confirming twice never pays or rewards twice.

| Code | Meaning | App should |
|---|---|---|
| `402` | Declined. `payment.status` → `failed`, still `payable` | Show it, call `initiate` again |
| `409` | `You can pay once the professional marks the work done` | Not `completed` yet |
| `409` | `orderId does not match the payment in progress` | Stale orderId — re-initiate |
| `422` | Bad `method` | — |

Show the reward in the success state, since it's the reason they took the offer:
*"Paid ₹100 · ₹40 reward added to your wallet."*

---

### 3.7 The feedback form — this is what onboards the worker

```
GET /api/user/trials/:id/feedback-form
```

```json
{
  "success": true,
  "trial": { "id": "...", "category": "cleaning", "completedAt": "..." },
  "worker": { "name": "Ramesh Kumar", "isTrainee": true },
  "questions": [
    {
      "key": "q1",
      "prompt": "Did the worker arrive on time?",
      "type": "single",
      "optional": false,
      "options": [
        { "value": "on_time", "label": "On time" },
        { "value": "slightly_late", "label": "Slightly late" },
        { "value": "very_late", "label": "Very late" }
      ]
    },
    "… q2 … q9 …",
    { "key": "q10", "prompt": "Any additional comments? (optional)", "type": "text", "optional": true }
  ]
}
```

**Render the form from this response — never hardcode the questions.** The wording
is explicitly placeholder-quality and will change; the `value` strings are the
stable contract. `type` is `single` (radio) for q1–q9 and `text` for q10, which is
the only optional one.

The response deliberately does **not** say which answer is the "good" one. Don't
try to infer or hint it — the scoring thresholds are server-side, and a form that
telegraphs the right answer is worthless as a filter.

```
POST /api/user/trials/:id/feedback
{ "answers": { "q1": "on_time", "q2": "presentable", "...": "...", "q9": "yes_definitely", "q10": "Very thorough." } }
```

```json
{
  "success": true,
  "message": "Thank you — your feedback helped a new professional get onboarded",
  "trial": { "feedbackSubmitted": true, "...": "..." },
  "outcome": { "workerApproved": true, "underReview": false }
}
```

`outcome` drives the thank-you copy only:

| `outcome` | Copy |
|---|---|
| `workerApproved: true` | "Thanks — Ramesh is now a verified Kaaryo professional." |
| `underReview: true` | "Thanks — our team will review your feedback." |
| `workerApproved: false, underReview: false` | "Thanks for your feedback." — **do not** say the worker was rejected |

Three rules on this screen:

1. **Single submission.** Re-posting is a `409`
   (`Feedback has already been submitted for this trial`). Disable the button on
   the first success and drive the UI from `feedbackSubmitted`.
2. **Never show the raw verdict.** The engine's internal values
   (`strong_pass` / `conditional` / `fail`) are not returned, and `outcome` should
   not be rendered as a hiring decision. The customer rated a job; they didn't sit
   on a panel.
3. **Don't tell the customer they rejected someone.** If the answers fail the
   worker, thank the customer and stop. That's why `workerApproved: false` has no
   distinct message above.

Errors: `409` already submitted · `409 This trial is not yet ready for feedback`
(not `completed`) · `422` missing/invalid answer (message names the question).

---

### 3.8 `GET /api/user/wallet`

```json
{
  "success": true, "message": "Reward wallet",
  "balance": 40, "currency": "INR",
  "redeemable": false,
  "transactions": [
    {
      "id": "...", "type": "credit", "amount": 40, "currency": "INR",
      "source": "trial_reward", "note": "Trial reward · 40% of ₹100",
      "createdAt": "..."
    }
  ]
}
```

**`redeemable: false` — spending the balance is not built.** Show the balance and
the statement; do not build a "use ₹40 off this booking" control, it has no
endpoint behind it. Branch on the flag rather than hardcoding, so the screen
lights up when redemption ships.

---

## 4. Real-time (Socket.IO)

Same connection as the normal customer flow — one socket, your user token:

```js
const socket = io('http://16.112.64.28:4000', { auth: { token: userToken } });
```

| Event | Payload | Meaning |
|---|---|---|
| `trials:active` | `{ trials: [trial] }` | Snapshot on connect (only sent if you have live trials) |
| `trial:searching` | `{ trial, candidateNumber, candidateCount }` | Offer rolled to the next trainee |
| `trial:accepted` | `{ trial }` | **A trainee took it** — `trial.worker` now populated |
| `trial:started` | `{ trial }` | They started work |
| `trial:feedback_requested` | `{ trial, reminder }` | Work done → pay + rate |
| `trial:paid` | `{ trial, rewardCredited }` | Payment captured, reward credited |
| `trial:no_workers` | `{ trial, reason }` | Queue spent — `canRetry` is `true` |
| `trial:cancelled` | `{ trial }` | Cancelled (fires on your other devices too) |

Every payload's `trial` is the same shape as the REST responses. These are a
separate namespace from `request:*`, so an app that hasn't built trial screens
simply never listens for them.

Polling `GET /api/user/trials/:id` every 3–5s while `status === 'assigned'` gives
the same information — ship polling first if it's simpler.

---

## 5. The `trial` object

```
id                  string
type                'trial'          ← use this to tell trial cards from normal ones
status              'assigned' | 'accepted' | 'in_progress' | 'completed' | 'declined' | 'expired'

category            always 'cleaning'
subcategory         'kitchen' | null
jobDescription, address, location, scheduledTime

pricing.basePrice           110   ← struck through
pricing.userPrice           100   ← what they pay
pricing.userSavings         10
pricing.userDiscountPercent 9
pricing.rewardPercent       40
pricing.rewardAmount        40
   (no workerEarning — the worker/platform split is internal, as in normal jobs)

── search telemetry, while status === 'assigned' ──
candidateNumber     which trainee is being asked right now (1-based) → "asking 2 of 3"
candidateCount      how many will be tried in total
offerExpiresAt      THIS trainee's 90s deadline
searchExpiresAt     the WHOLE search's deadline  ← render the customer countdown off this
secondsRemaining    convenience snapshot; 0 unless 'assigned'
searchAttempt       1, +1 per retry

── server-decided affordances: render buttons off these ──
canCancel           assigned | accepted | in_progress
canRetry            declined | expired
feedbackPending     completed AND not yet submitted   ← show the "Rate" CTA
feedbackSubmitted   boolean
payment.payable     completed AND not yet paid        ← show the "Pay" CTA

payment.{ status, amount, currency, method, orderId, transactionId, attempts,
          failureReason, dueAt, paidAt }
   status: 'not_due' | 'due' | 'processing' | 'paid' | 'failed'

reward.{ amount, percent, credited, creditedAt }

── present once a trainee has accepted ──
worker.{ id, name, phone, rating, jobsCompleted, distanceKm, isTrainee: true }

acceptedAt, startedAt, completedAt, createdAt
endedReason         'worker_declined' | 'timeout' | 'customer_cancelled'  (declined/expired only)
```

### Status → screen

| `status` | What it means | Screen |
|---|---|---|
| `assigned` | Offer out to a trainee, countdown running | **Searching** (this is the "searching" state — there is no `searching` value) |
| `accepted` | A trainee is coming | Tracking + worker card |
| `in_progress` | They're working | Tracking |
| `completed` | Work done | **Pay** and/or **Rate** — check `payment.payable` and `feedbackPending` |
| `declined` / `expired` | Nobody took it | **No trainees** + Retry (`canRetry`) |

```js
function trialScreen(t) {
  switch (t.status) {
    case 'assigned':    return 'searching';
    case 'accepted':
    case 'in_progress': return 'tracking';
    case 'completed':
      if (t.payment.payable) return 'payment';
      if (t.feedbackPending) return 'feedback';
      return 'receipt';
    case 'declined':
    case 'expired':     return t.canRetry ? 'retry' : 'unavailable';
    default:            return 'home';
  }
}
```

Two rules, same as the normal flow:

**Render the countdown from `searchExpiresAt`**, not a local timer — the server
owns when the search dies, and it must survive backgrounding:

```js
const left = Math.max(0, Math.ceil((new Date(t.searchExpiresAt) - Date.now()) / 1000));
```

**Use `payment.payable`, `feedbackPending`, `canCancel`, `canRetry` as given.**
Don't re-derive them from `status` — they encode server-side rules that will drift
out of sync with a client-side copy.

### The searching screen deserves care

Up to three trainees are asked **one at a time**, 90 seconds each — a trial is a
directed offer, not a broadcast, because accepting one moves a real person's
onboarding forward and only one can. So the wait is longer than a normal booking
(up to ~4.5 min) and it visibly progresses. Use `candidateNumber` /
`candidateCount`:

> Asking professional **2 of 3** nearby… *(2:14 left)*

Let the customer leave the screen — the booking stays live and they'll get
`trial:accepted` (or find it via `/active`) whenever it lands.

---

## 6. Screens to build

1. **Home card** — gated on `GET /offer`. Price, struck-through base, reward,
   and the honest "you'll be matched with a professional completing onboarding".
2. **Booking form** — subcategory chips (optional) + description + location +
   optional time. Show the full price breakdown before the button.
3. **Searching** — `candidateNumber of candidateCount` + the `searchExpiresAt`
   countdown. Cancel available.
4. **No trainees available** — for both `NO_TRIAL_WORKERS` at booking time and
   `trial:no_workers` after the queue is spent. Retry when `canRetry`, plus a
   "book a regular service instead" escape hatch.
5. **Tracking** — worker card with a **trainee badge**, call button on
   `worker.phone`.
6. **Payment** — reuse the normal payment screen. Show the reward in the success
   state.
7. **Feedback (10 questions)** — rendered from `/feedback-form`. One submission.
   Frame it as *"help this professional get onboarded"*, which is true and lifts
   completion.
8. **Wallet** — balance + statement. No redemption control (`redeemable: false`).

---

## 7. Not built — don't design around it

- **Redeeming the reward.** Balance only. `redeemable: false`.
- **Any category but cleaning.** No electrical/plumbing/etc. trial exists.
- **Choosing your trainee.** The queue is distance-ordered and server-picked.
- **Live location / ETA** for the trainee. `worker` has no live position.
- **Rating the worker with stars.** The 10-question form replaces it, and its
  result is an onboarding decision, not a public rating.
- **Cancellation fees.** Cancelling is free and doesn't consume the allowance —
  which does mean a customer can cancel repeatedly after a trainee accepted. There
  is no abuse guard on that yet; flagged, not fixed.
- **Trial payouts on a failed trial.** If feedback fails the worker they are not
  approved, and the existing policy pays out only on approval — so the customer's
  ₹100 is collected but the worker isn't credited. That predates this flow and
  wasn't changed here; raise it if the policy should differ.
- **More than one trial per account** (default `allowance: 1`) — config, not code.
- **Push notifications** to the customer. Socket only, as with normal bookings.

---

## 8. What changed on the backend

**New**

| File | Purpose |
|---|---|
| `src/routes/userTrialRoutes.js` | The 11 customer trial endpoints |
| `src/controllers/userTrialController.js` | Offer / book / track / pay / rate |
| `src/services/userTrialService.js` | Candidate queue, sequential offer, payment, reward |
| `src/services/trialFeedbackService.js` | Shared questions + validation + onboarding path |
| `src/services/paymentGateway.js` | The gateway seam, extracted so both payment flows share it |
| `src/models/UserWalletTransaction.js` | Append-only customer reward ledger |
| `src/routes/userWalletRoutes.js` | `GET /api/user/wallet` |

**Modified**

| File | Change |
|---|---|
| `src/services/pricingService.js` | `computeTrialPrice` rewritten: absolute `userPrice`, `userReward`. Old percentage knobs still honoured as fallbacks |
| `src/models/TrialJob.js` | Added `source`, `requestedBy`, `candidates[]`, `candidateIndex`, `searchExpiresAt`, `searchAttempt`, `payment{}`, `reward{}`; `submittedVia` gained `'user_app'`; `declinedReason` gained `'customer_cancelled'`. **`status` enum unchanged** |
| `src/services/trialJobsService.js` | Offer expiry rolls to the next candidate for user bookings; feedback request goes in-app (no token link) and marks payment due |
| `src/controllers/trialWorkerController.js` | Side effects only — customer pushes, candidate roll on decline. **Response shapes unchanged** |
| `src/controllers/trialFeedbackController.js` | Now delegates to `trialFeedbackService`; same behaviour |
| `src/services/paymentService.js` | Uses the extracted gateway |
| `src/realtime/socket.js` | Adds the `trials:active` snapshot |
| `server.js`, `.env` | Route mounts + the trial pricing/booking knobs |

### The worker app still needs no changes

A customer-booked trial reaches the worker as an ordinary trial job: same
`trial:assigned` socket payload, same `pending_trial → trial_assigned` transition,
same `/api/worker/trial/*` endpoints and response shapes, same `TrialJob.status`
values. The worker never learns they were one of three candidates.

Two behaviours changed *behind* unchanged responses:

- **Declining a customer-booked trial rolls the offer on** instead of ending it.
  The declining worker's own response is snapshotted before the roll, so they're
  told about the offer they declined — not the one that moved to someone else.
- **A customer-booked trial no longer SMSes a tokenised feedback link.** The host
  has a session and an in-app form, so minting a second, weaker credential would
  be a downgrade. Admin-assigned trials keep the SMS link exactly as before.


## 9. Ready-to-paste brief

> Add the **discounted trial booking** flow to the Kaaryo customer app. Base URL
> `http://16.112.64.28:4000`; all routes need the existing customer token
> (`Authorization: Bearer <token>`). Responses are flat JSON —
> `{ success, message, ...payload }`.
>
> **What it is:** a cheap cleaning job done by a professional who is completing
> their onboarding. The customer pays **₹100** on a **₹110** job and gets **₹40
> back** as a wallet reward (effectively ₹60). After the job the customer fills a
> 10-question form, **and that form is what gets the professional onboarded** —
> say so on screen, it's true and it lifts completion.
>
> **CLEANING ONLY.** Never send a `category` field. Electricians have no trial.
>
> **Statuses are different from normal bookings** — `assigned` (= searching) /
> `accepted` / `in_progress` / `completed` / `declined` / `expired`. There is no
> `searching` or `pending_rating`. Do not reuse the service-request switch.
>
> **Endpoints:**
> - `GET /api/user/trials/offer` → `{ available, reason, code, used, allowance, subcategories, pricing: { basePrice, userPrice, userSavings, rewardPercent, rewardAmount, netCost }, offerWindowSeconds }`. **Gate the home card on `available`.** `code` is `TRIAL_IN_PROGRESS` (with `liveTrialId`) / `TRIAL_ALLOWANCE_USED` / `TRIAL_DISABLED`.
> - `POST /api/user/trials` — body `{ subcategory?, jobDescription, lat, lng, address?, scheduledTime? }` → `201 { trial, candidateCount }`. `409 NO_TRIAL_WORKERS` is a normal outcome (no trainee nearby) — build a real screen for it. `409 TRIAL_IN_PROGRESS` returns the live `trial`.
> - `GET /api/user/trials/active` → `{ trial }` or `{ trial: null }`. Call on launch.
> - `GET /api/user/trials` → `{ active: [full], history: [summary] }`.
> - `GET /api/user/trials/:id` → `{ trial }`. Poll every 3–5s while `status === 'assigned'`.
> - `POST /api/user/trials/:id/cancel` · `POST /api/user/trials/:id/retry` (when `canRetry`; no retry cap).
> - `POST /api/user/trials/:id/payment/initiate` — `{ method }` (`upi`/`card`/`netbanking`/`wallet`/`cash`) → `{ payment: { orderId, amount, mode } }`. Then `POST .../payment/confirm` — `{ orderId }` → `{ trial, rewardCredited, rewardAmount }`. Safe to retry. `402` = declined → initiate again. Reuse the existing payment screen.
> - `GET /api/user/trials/:id/feedback-form` → `{ worker: { name }, questions: [...] }`. **Render from this; never hardcode the questions.** q1–q9 are single-choice, q10 is optional free text. The response does not reveal which answer is "good" — don't hint it.
> - `POST /api/user/trials/:id/feedback` — `{ answers: { q1..q10 } }` → `{ outcome: { workerApproved, underReview } }`. One submission only (`409` after). Use `outcome` for thank-you copy; **never tell the customer they rejected someone** — if `workerApproved` is false, just thank them.
> - `GET /api/user/wallet` → `{ balance, currency, redeemable, transactions }`. **`redeemable` is `false` — do not build a "spend reward" control.**
>
> **The `trial` object** is identical across REST and socket. Render buttons from
> the server's flags, not from `status`: `payment.payable`, `feedbackPending`,
> `canCancel`, `canRetry`. Render the countdown from `searchExpiresAt` (absolute),
> not a local timer.
>
> **Searching screen:** up to 3 trainees are asked **one at a time**, 90s each, so
> the wait can reach ~4.5 minutes and it progresses visibly. Show
> `"Asking professional {candidateNumber} of {candidateCount}"` plus the
> countdown, and let the customer leave the screen — the booking stays live.
>
> **Live updates (optional):** same `socket.io-client` connection as normal
> bookings, `{ auth: { token } }`. Events, each carrying `{ trial }`:
> `trials:active`, `trial:searching`, `trial:accepted`, `trial:started`,
> `trial:feedback_requested`, `trial:paid`, `trial:no_workers`, `trial:cancelled`.
> Polling alone works.
>
> **Screens:** home card → booking form → searching → no-trainees/retry →
> tracking (trainee badge + call) → payment → 10-question feedback → wallet.
>
> **Do not build:** reward redemption, non-cleaning trials, picking your trainee,
> trainee live location/ETA, star ratings, or more than one trial per account.
