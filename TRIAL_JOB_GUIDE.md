# Filter 2: Trial Job — Backend Guide

The final onboarding gate. After a worker clears application review, they do **one
subsidised trial job**. A customer submits feedback, a decision engine (or admin)
scores it, and the worker is either **approved** (can now accept normal jobs) or
**rejected**.

This slots in *before* the existing `approved` status, which is still the gate
the dispatch engine checks ([dispatchService.js](src/services/dispatchService.js)) —
so a worker can only accept real jobs after passing the trial.

> The customer/user app does not exist yet. For demos, the trial request is
> created via the **admin assign** endpoint and feedback is submitted via the
> **public signed link** (both shown below).

---

## Worker status flow

`worker.status` gains five trial states (set server-side only, every change
recorded in the `worker_status_transitions` collection):

```
under_review ──(admin "approve")──► pending_trial
pending_trial ──(admin assigns)───► trial_assigned
trial_assigned ─(worker accepts)──► trial_accepted ─(start)─► trial_in_progress
trial_in_progress ─(complete)─────► trial_completed
trial_completed ─(strong_pass│admin approve)─► approved   ✅ can accept normal jobs
trial_completed ─(fail│admin reject)─────────► rejected

trial_assigned ─(decline│offer timeout)──────► pending_trial   (back in queue)
```

Toggle the whole filter with `TRIAL_ENABLED` (default **on**). When off, the
admin "approve" button keeps its legacy meaning (straight to `approved`).

---

## Worker-facing API  (`/api/worker/trial`, worker JWT)

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/status` | `{ status, currentTrialJob }` — fallback poll for the waiting/submitted screens |
| `POST` | `/:id/accept` | accept the offer → `trial_accepted` (rejects if expired) |
| `POST` | `/:id/decline` | decline → back to `pending_trial` (logged as an ops signal) |
| `POST` | `/:id/start` | begin the job → `trial_in_progress` |
| `POST` | `/:id/complete` | `{ photos?, notes? }` checkout → `trial_completed`, triggers the feedback request |

The host's phone number is **hidden pre-accept** and revealed after acceptance,
mirroring normal jobs.

### Real-time (Socket.IO, worker room — already wired)

| Event | Payload | When |
|---|---|---|
| `trial:assigned` | `{ jobId, host{name,address,lat,lng}, scheduledTime, rate, offerExpiresAt }` | admin assigns |
| `worker:status_changed` | `{ status, reason? }` | every trial transition (accept/decline/start/complete, decision, admin decision) |

Both also fire a mock push/SMS via [notificationService](src/services/notificationService.js)
in case the socket is disconnected.

---

## Driving a demo

Assume the server runs on `http://localhost:4000` (`PORT` in `.env`).

### 1. Get an admin token
```bash
npm run seed:admin   # ensures the .env admin exists
curl -s localhost:4000/api/admin/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@kaaryo.com","password":"Admin@123"}'
# → { token: "<ADMIN_TOKEN>", ... }
```

### 2. Put a worker in `pending_trial`
Approve any worker sitting in application review (`submitted`/`under_review`):
```bash
curl -s -X POST localhost:4000/api/admin/workers/<WORKER_ID>/approve \
  -H 'Authorization: Bearer <ADMIN_TOKEN>'
# worker.status → pending_trial
```

### 3. Make the demo trial request (admin assign)
```bash
curl -s -X POST localhost:4000/api/admin/trial/assign \
  -H 'Authorization: Bearer <ADMIN_TOKEN>' -H 'Content-Type: application/json' \
  -d '{
    "workerId":"<WORKER_ID>",
    "hostName":"Demo Host","hostPhone":"9111111111",
    "lat":12.9716,"lng":77.5946,"address":"1 Demo St",
    "category":"cleaning","subcategory":"kitchen",
    "jobDescription":"Trial kitchen clean","scheduledTime":"2026-07-24T10:00:00Z"
  }'
# → { trialJob: { id, pricing{ totalPrice:195, ... }, offerExpiresAt } }
```
Rate is auto-subsidised to `TRIAL_RATE_PERCENT` of the standard rate (65% → ₹195
of ₹300). The worker gets a `trial:assigned` socket event + push.

### 4. Worker walks the flow (worker JWT)
```bash
curl -s -X POST localhost:4000/api/worker/trial/<JOB_ID>/accept   -H 'Authorization: Bearer <WORKER_TOKEN>'
curl -s -X POST localhost:4000/api/worker/trial/<JOB_ID>/start    -H 'Authorization: Bearer <WORKER_TOKEN>'
curl -s -X POST localhost:4000/api/worker/trial/<JOB_ID>/complete -H 'Authorization: Bearer <WORKER_TOKEN>' \
  -H 'Content-Type: application/json' -d '{"photos":["a.jpg"],"notes":"done"}'
```

### 5. Submit the demo feedback
On completion the feedback link is logged to the server console
(`🔗 [trial-feedback] link for job …`). You can also fetch it any time:
```bash
curl -s localhost:4000/api/admin/trial/<JOB_ID> -H 'Authorization: Bearer <ADMIN_TOKEN>'
# → trialJob.feedbackLink: "http://localhost:4000/api/public/trial-feedback/<TOKEN>"
```
Render the form (no auth), then submit answers:
```bash
curl -s localhost:4000/api/public/trial-feedback/<TOKEN>          # → { job, questions[10] }

curl -s -X POST localhost:4000/api/public/trial-feedback/<TOKEN> \
  -H 'Content-Type: application/json' \
  -d '{"answers":{
    "q1":"on_time","q2":"presentable","q3":"polite","q4":"yes","q5":"thorough",
    "q6":"prepared","q7":"good","q8":"comfortable","q9":"yes_definitely","q10":"Great!"
  }}'
# → { decision:"strong_pass", autoFinalized:true }  → worker.status = approved
```
The link is **single-use** — a second submit returns 409.

---

## Decision engine

Pure, unit-tested function in [trialDecisionService.js](src/services/trialDecisionService.js).
Run the tests: `npm run test:trial`.

- **`fail`** → any hard-fail answer: `q5=careless`, `q8=uncomfortable`, or `q9=no`.
  Auto-rejects the worker.
- **`strong_pass`** → every `q1..q8` is the positive answer **and** `q9=yes_definitely`.
  Auto-approves the worker.
- **`conditional`** → anything else. The worker stays `trial_completed` and the job
  surfaces in the admin queue for a manual decision.

The questions, allowed answers, positive values, and hard-fail flags all live in
[config/trialQuestions.js](src/config/trialQuestions.js) — **question wording there is
placeholder; swap in the final product copy** without touching the engine.

---

## Admin API  (`/api/admin`, admin JWT)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/trial/assign` | create + assign a trial job (demo request) |
| `GET`  | `/trial-queue` | `pendingTrial` workers, `awaitingDecision` (conditional), `awaitingFeedback` |
| `GET`  | `/trial/:id` | full job + feedback (+ a live `feedbackLink` while feedback is open) |
| `POST` | `/trial/:id/decision` | `{ decision:"approve"｜"reject", notes? }` — finalise a `conditional` |

---

## Background sweeper

[trialJobsService](src/services/trialJobsService.js) runs every
`TRIAL_SWEEP_INTERVAL_SECONDS` (15s):
- **Offer expiry** — an `assigned` job past `offerExpiresAt` → `expired`, worker → `pending_trial`.
- **Feedback SLA** — reminder SMS at `TRIAL_FEEDBACK_SLA_MINUTES` (30); ops flag
  (console/Slack) + a reassurance push to the worker at `TRIAL_FEEDBACK_OVERDUE_HOURS` (4).

---

## Config (`.env`, all optional — sane defaults)

| Var | Default | Meaning |
|---|---|---|
| `TRIAL_ENABLED` | `true` | master switch for the whole filter |
| `TRIAL_RATE_PERCENT` | `65` | trial pay as % of standard rate |
| `TRIAL_OFFER_WINDOW_SECONDS` | `90` | accept-offer countdown |
| `TRIAL_FEEDBACK_SLA_MINUTES` | `30` | feedback reminder threshold |
| `TRIAL_FEEDBACK_OVERDUE_HOURS` | `4` | feedback overdue → ops flag |
| `TRIAL_FEEDBACK_TOKEN_TTL` | `48h` | feedback link lifetime |
| `TRIAL_SWEEP_INTERVAL_SECONDS` | `15` | sweeper cadence |
| `PUBLIC_BASE_URL` | `http://localhost:$PORT` | base used to build feedback links |

Signed feedback links reuse `JWT_SECRET`; the admin flow uses `ADMIN_JWT_SECRET`.
