# Electrical Shop Assessment — End-to-End Testing Guide

Filter 3 of the Kaaryo onboarding funnel. Electricians do **not** do the practical
video task (Filter 1) or the paid trial job (Filter 2) — instead they attend a
45-minute hands-on assessment at a partner electrical shop.

There are **four actors**. This guide is organised around who does what:

| Actor | Interface | Who plays it while testing |
|---|---|---|
| Worker | React Native app | the worker app team |
| Shop owner | mobile web form opened from an SMS/WhatsApp link | **you** (paste the link into a browser or curl it) |
| Ops / admin | `admin.html` | **you** |
| Backend | Express + MongoDB | already done |

---

## 1. Setup (once)

```bash
npm install                       # nothing new was added — no new dependencies
npm run seed:admin                # admin@kaaryo.com / Admin@123
npm run seed:shops -- --lat <your-lat> --lng <your-lng> --city Bengaluru --days 7
npm run dev
```

**Pass your test device's real coordinates to `seed:shops`.** Check-in is geofenced
to 500 m of the shop, so seeding shops around wherever the phone actually is makes
the happy path work without faking GPS. The script is idempotent — re-run it any
time to top the calendar back up. `--reset` deletes the seeded shops and their slots.

Server starts on **http://localhost:4000**. On boot you should see:

```
⚡ Assessment sweeper running every 60s (no-show + feedback SLA) · slow tasks every 3600s (deferred payouts + partner quality)
```

Admin panel: **http://localhost:4000/admin** → two new buttons, **⚡ Assessment
Queue** and **🏪 Shop Partners**.

### Recommended `.env` overrides while testing

The production defaults make manual testing slow (you'd have to be at the shop,
within 30 minutes of the slot, and wait a day for payouts). These make it
practical — remove them before going live:

```bash
ASSESSMENT_CHECKIN_RADIUS_M=50000        # check in from anywhere (default 500)
ASSESSMENT_CHECKIN_OPENS_MIN=10080       # check-in opens a week early (default 30)
ASSESSMENT_CHECKIN_CLOSES_MIN=10080      # …and stays open (default 60)
ASSESSMENT_CANCEL_CUTOFF_HOURS=0         # cancel any time (default 24)
ASSESSMENT_NO_SHOW_GRACE_MIN=0           # mark no-show immediately (default 15)
ASSESSMENT_DEFERRED_JOBS=1               # deferred payout after 1 job (default 10)
ASSESSMENT_SWEEP_INTERVAL_SECONDS=15     # faster background sweeps (default 60)
```

SMS, WhatsApp and payouts are all **mocked** — they print to the server console.
`SMS_MODE=mock`, `WHATSAPP_MODE=mock`, `PAYOUT_MODE=mock`. Watch the terminal:
that's where you'll find the shop owner's form link.

---

## 2. Getting a worker to the assessment gate

A worker can only book once they are in status **`pending_assessment`**. Two things
must be true:

1. **Their trade must be `electrical`.** The worker app sets this at Screen 6:

   ```http
   PUT /api/onboarding/work-details
   Authorization: Bearer <worker JWT>

   {
     "primaryCategory": "electrical",          ← NEW, this is what routes them here
     "skills": ["wiring", "switch_socket"],    ← validated against the electrical catalog
     "experience": "3_5",
     "workingHours": "flexible",
     "workingDays": "all_days",
     "ownsEquipment": true,
     "equipmentList": ["tester", "screwdriver set"]
   }
   ```

   `primaryCategory` is optional and defaults to `"cleaning"`, so the existing
   cleaning flow is unchanged. `skills` is an alias for the old `cleaningTypes`
   (either key works). Valid electrical skills: `wiring`, `fan_installation`,
   `switch_socket`, `appliance_repair`, `lighting`.

2. **An admin must clear application review.** In the admin panel, open the worker
   and hit **Approve**. Because their trade is `electrical`, this moves them to
   `pending_assessment` (not `pending_trial`) and no video task is required.

> **Sanity check:** approving a *cleaning* worker must still send them to
> `pending_trial`. If that broke, the trade gate is misconfigured.

### Worker status machine

```
pending_assessment              → worker must book a slot
assessment_booked               → slot held, assessment upcoming
assessment_checked_in           → arrived at the shop, session under way
assessment_feedback_submitted   → shop owner submitted feedback, admin reviewing
assessment_approved             → passed; app shows the certificate screen
assessment_rejected             → failed; app shows the tailored rejection screen
approved                        → worker tapped "Continue" — main tabs + dispatch gate
```

**These names are fixed by the worker app's routing table** (`ASSESSMENT_STATUSES`
in its `AuthContext`). A status outside that set falls through to the generic
"application submitted" screen, so don't rename them without the app.

Note the two-step ending: approval lands the worker on `assessment_approved`, not
`approved`. That's what shows the certificate. Tapping **Continue** calls
`POST /acknowledge-decision`, which promotes them to `approved` and opens the
dispatch gate. Rejection is terminal at `assessment_rejected` — that status is what
gives the tailored rejection screen (general reason + reapply date) rather than the
generic application-rejected one.

Every transition is pushed to the worker's socket room (`worker:<id>` — the same
room that already delivers `jobs:open`) as `worker:status_changed`, plus
`assessment:updated` / `assessment:status_changed` on any record change. Payloads
are a nudge only: the app re-reads `GET /api/worker/assessment/status`. There is no
polling on the client.

---

## 3. The worker app's API contract

All routes need `Authorization: Bearer <worker JWT>`, base path
`/api/worker/assessment`. The guide's `workerId` parameters are accepted but
validated against the JWT — a mismatch returns **403**, so the app can simply omit
them.

| Screen | Call |
|---|---|
| 1 · Intro | `GET /intro` |
| 2 · Slot picker | `GET /available-slots?latitude=&longitude=` |
| 2 → 3 · Book | `POST /book-slot` `{ slotId }` |
| 3 · Reschedule | `POST /cancel-booking` `{ assessmentId, cancellationReason }` |
| 4 · Check in | `POST /check-in` `{ assessmentId, latitude, longitude }` |
| 5/6 · Status poll | `GET /status` (or `/status/:workerId`) |
| 6 · Certificate | `GET /certificate` |
| 6 · Continue | `POST /acknowledge-decision` `{ assessmentId? }` |

### `GET /intro`
Returns the Screen 1 copy (`heading`, `explanation`, `whatToExpect[]`,
`whatToBring[]`, `ctaLabel`) plus `eligible` / `reason`. Copy is server-side so it
can change without an app release. **If `eligible` is false, show `reason` instead
of the Find Slots button.**

### `GET /available-slots`
Query: `latitude`, `longitude` (optional — falls back to the worker's heartbeat
location; without either, distances come back `null`), `city` (defaults to the
worker's city, pass `city=any` to search everywhere), `fromDate`, `toDate`
(`YYYY-MM-DD`, defaults to the next 7 days; `dateFrom`/`dateTo` also accepted).

Returns **both** shapes — a flat `slots[]` and a pre-grouped `slotsByDate[]` — so
the client can use whichever it prefers:

```json
{
  "success": true,
  "slotsByDate": [
    {
      "date": "2026-07-29",
      "label": "Today",
      "slots": [{
        "slotId": "…", "shopName": "Sri Balaji Electricals",
        "shopAddress": "…", "locality": "Koramangala",
        "googleMapsLink": "https://www.google.com/maps/search/?api=1&query=12.97,77.59",
        "distanceKm": 0.53, "slotDate": "2026-07-29",
        "slotStartTime": "10:00", "slotEndTime": "11:00",
        "startsAt": "2026-07-29T04:30:00.000Z", "endsAt": "…",
        "displayTime": "10:00 AM to 11:00 AM",
        "ownerName": "Ramesh Kumar", "seatsLeft": 1
      }]
    }
  ],
  "totalSlots": 32, "searchRadiusKm": 25
}
```

`slotsByDate` is already grouped with a `label` (`Today` / `Tomorrow` /
`Wednesday, 12 Mar`) and sorted nearest-first inside each group. The flat `slots[]`
carries the same objects in day-then-distance order, so client-side grouping
preserves the ordering.

`slotDate` / `slotStartTime` / `slotEndTime` are plain date and time-of-day
strings, never ISO timestamps, so a 10 AM slot can't drift onto another day through
timezone conversion. The absolute instants are separate (`startsAt` / `endsAt`).
Each slot also carries `ownerPhone`, `latitude` and `longitude` for the
tap-to-call and directions buttons.

**Non-200s to handle:** `403` with a machine-readable `reason` —
`wrong_category` (not an electrician), `already_booked`, `booking_suspended`,
`reapply_cooldown`, `wrong_stage`. `already_booked` also includes
`currentAssessment`, so the app can jump straight to the confirmation screen
rather than showing an empty picker.

### `POST /book-slot`
`201` on success with the full `assessment` object (shop details, owner phone,
`checkIn` window, `canCancel`, `nextSteps`).

**`409` means exactly one thing: the slot is gone — reload the list and pick
another.** It is never used for anything with a different remedy. The `reason`
field distinguishes `slot_taken` (the race), `slot_withdrawn`, `slot_started` and
`shop_inactive`; all four have the same fix, so showing the message verbatim is
correct. The race is real, not theoretical: booking is an atomic compare-and-swap,
so exactly one of two simultaneous taps wins.

"You already have an assessment in progress" is deliberately **403**
(`reason: "already_booked"`), not 409, precisely so it can't be mistaken for a
taken slot.

### `POST /check-in`
Two gates, both enforced server-side:

Both failures return **400** with a human-readable `message` (rendered verbatim by
the app) and a `reason` code:

- **Distance:** within 500 m of the shop. Too far → `reason: "outside_geofence"`,
  plus `distanceMeters` and `allowedMeters` so the app can say how far off they are.
- **Time:** only inside `checkIn.opensAt … checkIn.closesAt` (30 min before → 60
  min after the slot start). Outside → `checkin_not_open_yet` /
  `checkin_window_closed`.

400 on this endpoint is reserved for these two cases — it is not used for generic
validation errors (a missing `assessmentId` is a `422`).

On success returns `distanceMeters` and `ownerPhone` (so the worker can call if
they can't find the owner). The `checkIn` object in `/status` tells the app when to
enable the button — don't compute the window client-side only.

### `GET /status` — also `GET /status/:workerId`
The screen router, and the single source of truth for every assessment screen.
Returns top-level `status` (the **worker** status, which is what the app routes on;
also mirrored as `workerStatus`), `stage`, the latest `assessment`, `certificate`,
`canBook`, `blockedReason`, `counters`, `bookingSuspendedUntil`,
`reapplyAllowedAt`. `assessment: null` means nothing booked → show the intro.

The `assessment` object carries everything the screens need flattened onto it:
`slotStartTime` / `slotEndTime` display strings, `shop` (with `fullAddress`,
`ownerPhone`, `latitude`, `longitude`, `googleMapsLink`), `checkIn` window,
`canCancel`, `workerArrivedAt`, `assessmentCompletedAt`, `feedbackSubmittedAt`,
`finalDecision`, `finalDecisionAt`, `decisionMessage`, `improvementAreas`,
`reapplyAfter`, `certificate`, `noShowCount`, `bookingSuspendedUntil`.

The worker never receives the scoring rubric, the numeric score or the shop
owner's raw answers — only the outcome plus worker-safe copy. `decisionMessage` is
a general reason and `improvementAreas` is at most two general coaching phrases
derived from weak answers (e.g. *"Quality and finish of electrical repair work"*),
never numbers. That's deliberate, and it is generated server-side so the app
can't accidentally leak it.

### `POST /acknowledge-decision`
Body `{ assessmentId?, workerId? }`. Promotes an `assessment_approved` worker to
`approved`. **Idempotent** — calling it twice, or before a decision exists, returns
`200` with `acknowledged: false` and changes nothing, so the client's best-effort
treatment is safe.

### `GET /certificate`
`404` until approved. Then:

```json
{ "certificate": { "certificateId": "KV-ELEC-A1B2C3D4",
  "workerName": "…", "title": "Kaaryo Verified Electrician",
  "issuedAt": "…", "issuedOn": "Tuesday, 28 Jul", "city": "Bengaluru" } }
```

---

## 4. Playing the shop owner

The shop owner has no app and no account — **the link is the credential.** When a
worker books, the console prints it:

```
🟢 [MOCK WHATSAPP] to 9800000001 (template: assessment_booked): A Kaaryo worker named …
  View details and submit feedback after the session: http://localhost:4000/api/partner/assessment/form/eyJhbGci…
```

You can also get a live link any time from the admin panel: open the assessment →
**Shop owner form link**. Or via API: `GET /api/admin/assessments/:id` →
`assessment.feedbackLink`.

The token is scoped to that one assessment and expires 24 h after the slot ends.

### Read the form

```bash
curl -s http://localhost:4000/api/partner/assessment/form/<TOKEN> | jq
```

Returns the worker's name, the slot time, `checkedIn`, the payout note, and
`fields[]` — the full form definition (8 fields, each with `page`, `type`,
`prompt`, `options`, `minLength`). **The web form should render from `fields[]`**
rather than hard-coding the questions, so copy changes need no redeploy. `page`
maps to the 5-page flow: 2 = safety question alone, 3 = skills, 4 = overall.

### Submit feedback

```bash
curl -s -X POST http://localhost:4000/api/partner/assessment/submit-feedback \
  -H 'Content-Type: application/json' -d '{
    "assessmentToken": "<TOKEN>",
    "isolatedCircuitBeforeTouching": true,
    "toolHandlingScore": 4,
    "repairQualityScore": 5,
    "askedSensibleQuestions": true,
    "wouldHireInShop": "yes",
    "overallRecommendation": "onboard",
    "tasksPerformed": "Replaced a faulty modular switch and rewired a ceiling fan regulator.",
    "additionalNotes": "Confident with the tester."
  }' | jq
```

Booleans accept `true/false` **or** `"yes"/"no"` — the API guide documents them as
booleans while the form shows Yes/No buttons, so both work. `wouldHireInShop`
additionally accepts `"maybe"`.

Validation to try: `tasksPerformed` under 20 chars → `422`; a missing mandatory
field → `422`; a rating outside 1–5 → `422`; submitting twice → `409` (single use);
submitting before the worker checked in → `409` telling you to use no-show instead.

On success the ₹300 upfront payout fires immediately (mocked, prints `💸 [MOCK
PAYOUT]`).

### Mark a no-show

```bash
curl -s -X POST http://localhost:4000/api/partner/assessment/mark-no-show \
  -H 'Content-Type: application/json' -d '{"assessmentToken":"<TOKEN>"}' | jq
```

Blocked until 15 min after the slot start (`409`). Pays nothing, ever.

---

## 5. Playing ops (admin panel)

**⚡ Assessment Queue** has three tabs:

- **Pending Review** — everything awaiting a decision, oldest first. The safety
  answer is a red/green badge in the row; a safety failure also paints a red banner
  across the top of the detail view. Clicking a row opens the full context: worker
  profile and prior onboarding results, the session (including check-in distance),
  every feedback answer with the preliminary score, payout state, and Approve /
  Reject with a notes field (mandatory to reject).
- **All Assessments** — every assessment in every state, with status tallies.
- **Payments** — pending ₹300 upfront and ₹200 deferred payouts, with **Mark paid**.
  Leave the reference blank and it puts the payout through the payout service;
  enter one and it records a manual transfer.

There's also **⚙ Run background jobs now** in the footer — runs no-show detection,
the feedback SLA, deferred payouts and partner quality scoring immediately instead
of waiting for the sweeper. Use it constantly while testing.

**🏪 Shop Partners** lists every partner with approval rate, average downstream
worker rating and a colour-coded quality score (green >80, amber 60–80, red <60).
Open one to add/withdraw slots in bulk, change status, recalculate the quality
score, and see the full assessment history at that shop.

Approving an assessment issues the certificate and sets the worker to `approved`.
Rejecting sets a 30-day reapply cooldown.

---

## 6. The happy path, end to end

1. **Worker app** — finish onboarding with `primaryCategory: "electrical"`, submit.
2. **Admin** — Approve the application. Worker status → `pending_assessment`.
3. **Worker app** — `GET /intro` (`eligible: true`) → `GET /available-slots` →
   slots grouped by day, nearest shop first.
4. **Worker app** — `POST /book-slot`. Status → `assessment_booked`. Console prints
   the worker SMS, the shop owner's link, and an ops alert.
5. **Worker app** — on the day, `POST /check-in` with GPS. Status →
   `assessment_checked_in`. Console prints *"… has just checked in at your shop."*
6. **You (shop owner)** — open the link, `POST /submit-feedback`. Assessment →
   `feedback_submitted`, worker → `assessment_feedback_submitted`, ₹300 paid.
7. **Admin** — Assessment Queue → Pending Review → open → **Approve**. Worker →
   `assessment_approved`.
8. **Worker app** — `GET /status` shows `finalDecision: "approved"` and the
   `certificate` object; the app shows the certificate screen. Tapping **Continue**
   calls `POST /acknowledge-decision` → worker becomes `approved` and the main tabs
   open.
9. **Later** — once the worker completes 10 jobs, the daily sweeper releases the
   ₹200 deferred half. Force it with **Run background jobs now** after setting
   `jobsCompleted` (or `ASSESSMENT_DEFERRED_JOBS=1`).

---

## 7. Cases worth testing

| # | Scenario | How | Expected |
|---|---|---|---|
| 1 | Slot race | Two workers `POST /book-slot` with the same `slotId` simultaneously | one `201`, one `409`; slot capacity lands at 0, never negative |
| 2 | Double booking | Book, then try to book again | `409` "already have an assessment in progress" |
| 3 | Check in too early | `POST /check-in` well before the slot | `409` "Check-in has not opened yet" |
| 4 | Check in too far | Send coords ~5 km away | `422` + `distanceMeters` |
| 5 | Double check-in | Check in twice | `409` |
| 6 | Cancel in time | Cancel a slot >24 h out | `200`; the slot returns to the picker |
| 7 | Cancel too late | Cancel a slot <24 h out | `409` |
| 8 | 2nd cancellation | Cancel twice | profile `flaggedForReview`, ops alert |
| 9 | Safety failure | Submit with `isolatedCircuitBeforeTouching: false` and 5/5 everywhere else | `safetyFailed: true`, engine says `reject` even though the score is 100 — and it still waits for an admin decision |
| 10 | Short task description | `tasksPerformed: "too short"` | `422` |
| 11 | Token replay | Submit the same token twice | `409` |
| 12 | Bad token | `GET /form/garbage` | `401` |
| 13 | No-show, partner-marked | `mark-no-show` after the grace period | worker → `pending_assessment`, slot freed, **no payout** |
| 14 | No-show, auto-detected | Book, let the check-in window pass, then Run background jobs | status `no_show`, `noShowMarkedBy: "system"` |
| 15 | 2 no-shows | Repeat #14 | `bookingSuspendedUntil` set 15 days out; slot search returns `403` |
| 16 | Reject | Reject an assessment | worker `rejected`, `reapplyAllowedAt` +30 days |
| 17 | Reject without notes | Omit `adminNotes` | `422` |
| 18 | Decide twice | Decide an already-decided assessment | `409` |
| 19 | Deferred payout gate | Run deferred payouts with `jobsCompleted < 10` | not paid; paid once the threshold is met, with the trigger event recorded |
| 20 | Partner terminated | Set a partner to `terminated` while a worker holds a slot there | future slots withdrawn, booking cancelled, worker told to rebook and returned to `pending_assessment` |
| 21 | Slot withdrawn | Withdraw a single booked slot | same rescue behaviour for that one worker |
| 22 | Quality auto-pause | See §8 | partner auto-paused below 60, auto-terminated below 40 |
| 23 | Wrong trade | A cleaning worker calls `/available-slots` | `403` |
| 24 | Cross-worker access | Worker A passes worker B's `assessmentId` | `403` |
| 25 | Spoofed workerId | `GET /status/<other worker id>` | `403` |
| 26 | Two-step approval | Approve, then `POST /acknowledge-decision` | `assessment_approved` → `approved`; a second call is a no-op `200` |
| 27 | Rejection copy | Reject, then `GET /status` | `decisionMessage` set, `improvementAreas` ≤2 items, no scores or rubric anywhere in the payload |
| 28 | Socket delivery | Connect a socket, then book | `assessment:updated`, `assessment:status_changed` and `worker:status_changed` all arrive in the same room as `jobs:open` |

All 28 of these were verified against a live server during implementation
(135 assertions, 0 failures).

---

## 8. Partner quality scoring

Runs monthly (and on demand via **Recalculate quality score** or
`POST /api/admin/shop-partners/:id/recalculate-quality`). For each partner it looks
at the workers they **approved** over the last 3 months:

```
100  base
−5   per approved worker who drew a complaint
−10  per approved worker removed from the platform
+2   per approved worker rated ≥ 4.5
clamped to 0…100
```

Below **60** → auto-paused. Below **40** → auto-terminated (future slots withdrawn,
booked workers told to rebook). This is what catches a shop owner who approves
everyone without genuinely assessing them.

To test it: approve several workers through one partner, set their `rating` low
(≤3.0) or their status to `rejected` in Mongo, then recalculate. Re-running for the
same month replaces that month's row rather than adding a duplicate.

> **Known limitation:** this codebase has no complaints collection yet, so
> "drew a complaint" is approximated by a low average rating and "removed from the
> platform" by `status === 'rejected'`. Both live in one function —
> `classifyWorker()` in [partnerQualityService.js](src/services/partnerQualityService.js) —
> so swap that when a real complaints model lands and every score follows.

---

## 9. Admin API reference

| Method | Path |
|---|---|
| POST | `/api/admin/shop-partners` |
| GET | `/api/admin/shop-partners?city=&status=&minQualityScore=&page=&limit=` |
| GET | `/api/admin/shop-partners/:partnerId` |
| PATCH | `/api/admin/shop-partners/:partnerId` |
| PATCH | `/api/admin/shop-partners/:partnerId/status` |
| POST | `/api/admin/shop-partners/:partnerId/recalculate-quality` |
| POST | `/api/admin/shop-partners/:partnerId/slots` |
| GET | `/api/admin/shop-partners/:partnerId/slots?includePast=` |
| DELETE | `/api/admin/shop-partners/:partnerId/slots/:slotId` |
| GET | `/api/admin/assessments/pending-review` |
| GET | `/api/admin/assessments?status=&partnerId=&workerId=&safetyFailed=` |
| GET | `/api/admin/assessments/:assessmentId` |
| POST | `/api/admin/assessments/:assessmentId/decide` |
| GET | `/api/admin/assessments/payments/pending` |
| POST | `/api/admin/assessments/:assessmentId/payments/:kind/mark-paid` |
| POST | `/api/admin/assessments/run-jobs` |

Bulk slot creation:

```bash
curl -s -X POST http://localhost:4000/api/admin/shop-partners/<ID>/slots \
  -H "Authorization: Bearer <ADMIN_JWT>" -H 'Content-Type: application/json' \
  -d '{"slots":[{"slotDate":"2026-08-02","slotStartTime":"10:00","maxWorkersPerSlot":1}]}'
```

`slotEndTime` defaults to start + 1 hour. Times are **shop-local (IST)** and
converted to absolute instants on the way in; duplicates at the same instant are
skipped rather than created.

---

## 10. Troubleshooting

**Empty slot list.** Slots are filtered by the worker's city *and* a 25 km radius
of their coordinates. Check the partner's city matches `worker.location.city`
exactly, or pass `city=any`. Re-run `npm run seed:shops` if the calendar ran out —
past slots are never offered.

**Check-in always 422.** The shop is more than 500 m from your test coordinates.
Re-seed with `--lat/--lng` at your actual location, or set
`ASSESSMENT_CHECKIN_RADIUS_M=50000`.

**Check-in always 409.** Outside the time window. Set
`ASSESSMENT_CHECKIN_OPENS_MIN=10080`, or move `scheduledAt` in Mongo.

**Can't find the shop owner's link.** Server console at booking time, or the admin
assessment detail view (`feedbackLink`), or `GET /api/admin/assessments/:id`.

**`403` on every worker assessment call.** The worker isn't `pending_assessment`,
or their `work.primaryCategory` isn't `electrical`. The response `message` says
which.

**Feedback submission says the worker hasn't checked in.** Geofenced check-in is
the proof of attendance, so it's required before feedback. If they genuinely never
arrived, use `mark-no-show`.

**Nothing happens in the background.** Use **⚙ Run background jobs now**, or
`POST /api/admin/assessments/run-jobs {"task":"all"}`. Tasks: `noShows`,
`feedbackSla`, `deferredPayments`, `partnerQuality`, `all`.

---

## 11. What was deliberately left out

- **The inbound WhatsApp bot.** Outbound WhatsApp notifications work (mocked
  through `whatsappService`, one function to swap for Interakt/AiSensy/Wati). The
  conversational flow that walks a less tech-savvy owner through the questions via
  quick replies needs a live provider account to build against; the token web form
  is the primary channel. When it's added it should reuse
  `config/assessmentQuestions` and post to the same submit endpoint with
  `submittedVia: "whatsapp"`.
- **Real payouts.** `payoutService` is mocked with the same `mock`/`real` MODE
  pattern as `smsService`; drop in RazorpayX/Cashfree behind `sendPayout()`.
- **The certificate image.** The backend exposes the certificate payload; rendering
  and sharing the image is the app's job.
