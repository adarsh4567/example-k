# Worker App — Trial Job Flow (React Native / Android Integration Guide)

The trial job is **Filter 2**, the final gate after application review. It picks up
right where the Screen 9 tracker ends: once an admin clears review the worker enters
`pending_trial`, does one subsidised trial job, a customer submits feedback, and the
worker ends at `approved` (can now take normal jobs) or `rejected`.

- **REST base URL:** `https://example-k.onrender.com`
- **Socket URL:** same origin (shares the existing Socket.IO connection from
  [WORKER_APP_REALTIME_GUIDE.md](WORKER_APP_REALTIME_GUIDE.md) — **do not open a second socket**)
- **Auth:** the same worker JWT (`Authorization: Bearer <token>` on REST, `auth.token` on the socket)

Everything is **status-driven**: the app reads `worker.status`, renders the matching
screen, and moves forward when the server pushes `worker:status_changed`. The client
never sets status itself.

---

## 1. The master routing switch

`worker.status` maps 1:1 to a screen. Extend your existing post-login router with the
five trial states:

| `worker.status` | Screen | What the worker sees |
|---|---|---|
| `submitted` / `under_review` / `manual_review` / `info_requested` | Screen 9 tracker | "Application under review" (existing) |
| `pending_trial` | **TrialWaitingScreen** | "You're approved for a trial — hang tight for a job" |
| `trial_assigned` | **TrialJobOfferScreen** | Offer card + countdown (accept / decline) |
| `trial_accepted` / `trial_in_progress` | **TrialActiveScreen** | Job details → Start → Complete |
| `trial_completed` | **TrialSubmittedScreen** | "Awaiting customer feedback" |
| `approved` | **Main app (Home)** | Go online, receive real offers |
| `rejected` | **TrialRejectedScreen** | "Trial not approved" |

```jsx
// src/navigation/TrialRouter.jsx
export function screenForStatus(status) {
  switch (status) {
    case 'pending_trial':     return 'TrialWaiting';
    case 'trial_assigned':    return 'TrialJobOffer';
    case 'trial_accepted':
    case 'trial_in_progress': return 'TrialActive';
    case 'trial_completed':   return 'TrialSubmitted';
    case 'approved':          return 'Home';
    case 'rejected':          return 'TrialRejected';
    default:                  return 'ApplicationTracker'; // submitted/under_review/…
  }
}
```

---

## 2. Trial API service

`src/services/trialApi.js` — thin wrappers over the worker-facing endpoints.

```js
import AsyncStorage from '@react-native-async-storage/async-storage';

const API = 'https://example-k.onrender.com';
const authHeader = async () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${await AsyncStorage.getItem('workerToken')}`,
});

// GET /api/worker/trial/status  → { success, message, status, currentTrialJob }
export async function getTrialStatus() {
  const r = await fetch(`${API}/api/worker/trial/status`, { headers: await authHeader() });
  return r.json();
}

// POST /api/worker/trial/:id/accept  → { success, message, trialJob }
export async function acceptTrial(id) {
  const r = await fetch(`${API}/api/worker/trial/${id}/accept`, { method: 'POST', headers: await authHeader() });
  return r.json();
}

// POST /api/worker/trial/:id/decline → { success, message, trialJob }
export async function declineTrial(id) {
  const r = await fetch(`${API}/api/worker/trial/${id}/decline`, { method: 'POST', headers: await authHeader() });
  return r.json();
}

// POST /api/worker/trial/:id/start   → { success, message, trialJob }
export async function startTrial(id) {
  const r = await fetch(`${API}/api/worker/trial/${id}/start`, { method: 'POST', headers: await authHeader() });
  return r.json();
}

// POST /api/worker/trial/:id/complete { photos?, notes? } → { success, message, trialJob }
export async function completeTrial(id, { photos = [], notes = '' } = {}) {
  const r = await fetch(`${API}/api/worker/trial/${id}/complete`, {
    method: 'POST', headers: await authHeader(), body: JSON.stringify({ photos, notes }),
  });
  return r.json();
}
```

### `currentTrialJob` / `trialJob` shape

Every endpoint above (except before assignment) returns the job in this shape.
**`host.phone` is `undefined` until you accept**, then populated.

```json
{
  "id": "66a0c1f0e4b0a1c2d3e4f5a6",
  "type": "trial",
  "status": "assigned",
  "category": "cleaning",
  "subcategory": "kitchen",
  "jobDescription": "Trial kitchen clean",
  "scheduledTime": "2026-07-24T10:00:00.000Z",
  "address": "1 Demo St",
  "location": { "type": "Point", "coordinates": [77.5946, 12.9716] },
  "host": { "name": "Demo Host" },
  "pricing": {
    "currency": "INR",
    "totalPrice": 195,
    "platformFeePercent": 10,
    "platformFee": 20,
    "workerEarning": 175,
    "trialRatePercent": 65,
    "standardTotalPrice": 300
  },
  "offerExpiresAt": "2026-07-23T19:41:30.000Z",
  "acceptedAt": null,
  "startedAt": null,
  "completedAt": null
}
```

> **Show the trial framing.** `pricing.trialRatePercent` (65) and `standardTotalPrice`
> (300) let you say "Trial rate — you'll earn ₹175 (trials pay 65% of the normal rate)".

---

## 3. Trial context (single source of truth)

Holds `status` + `currentTrialJob`, seeds from `getTrialStatus()`, and updates live off
the shared socket. Every trial screen reads from this; navigation reacts to `status`.

```jsx
// src/context/TrialContext.jsx
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { getSocket } from '../services/socket';
import { getTrialStatus } from '../services/trialApi';

const TrialContext = createContext();
export const useTrial = () => useContext(TrialContext);

export function TrialProvider({ children, navigationRef }) {
  const [status, setStatus] = useState(null);
  const [trialJob, setTrialJob] = useState(null);
  const [loading, setLoading] = useState(true);

  // 1. Seed from the fallback poll (also called on app resume).
  const refresh = async () => {
    const res = await getTrialStatus();
    if (res.success) { setStatus(res.status); setTrialJob(res.currentTrialJob); }
    setLoading(false);
    return res;
  };
  useEffect(() => { refresh(); }, []);

  // 2. Live updates off the shared socket — no polling.
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const onAssigned = (payload) => {
      // { jobId, host, scheduledTime, rate, offerExpiresAt } — fetch the full job.
      refresh();
    };
    const onStatusChanged = ({ status: next, reason }) => {
      setStatus(next);
      // Refresh the job so screens have fresh data; navigate to the new screen.
      refresh().then(() => navigationRef?.current?.navigate(screenForStatus(next)));
      if (reason) console.log('status_changed reason:', reason);
    };

    socket.on('trial:assigned', onAssigned);
    socket.on('worker:status_changed', onStatusChanged);
    return () => {
      socket.off('trial:assigned', onAssigned);
      socket.off('worker:status_changed', onStatusChanged);
    };
  }, []);

  return (
    <TrialContext.Provider value={{ status, trialJob, loading, refresh }}>
      {children}
    </TrialContext.Provider>
  );
}
```

Mount `<TrialProvider>` inside the authenticated tree, **after** `connectSocket()`, and
pass your `navigationRef` so status changes drive navigation. `screenForStatus` is the
switch from §1.

---

## 4. Screen-by-screen

### 4a. TrialWaitingScreen — `pending_trial`

No job yet. Purely informational; the app just waits for `trial:assigned`.

```jsx
function TrialWaitingScreen() {
  const { refresh } = useTrial();
  return (
    <View style={s.center}>
      <Text style={s.h1}>You're approved for a trial! 🎉</Text>
      <Text style={s.body}>
        We're matching you with a short trial job. You'll get a notification the moment
        it's ready — keep the app installed and notifications on.
      </Text>
      <Button title="Refresh" onPress={refresh} />
    </View>
  );
}
```

There is no worker action here. When ops assigns a job, the socket fires `trial:assigned`
→ `worker:status_changed {status:'trial_assigned'}` → the router pushes TrialJobOfferScreen.

---

### 4b. TrialJobOfferScreen — `trial_assigned`

Offer card + **countdown to `offerExpiresAt`**. Accept or decline.

```jsx
import { useTrial } from '../context/TrialContext';
import { acceptTrial, declineTrial } from '../services/trialApi';

function useCountdown(expiresAt) {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!expiresAt) return;
    const tick = () => setLeft(Math.max(0, Math.floor((new Date(expiresAt) - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [expiresAt]);
  return left; // seconds remaining
}

function TrialJobOfferScreen({ navigation }) {
  const { trialJob, refresh } = useTrial();
  const secondsLeft = useCountdown(trialJob?.offerExpiresAt);

  if (!trialJob) return <Loader />;

  const onAccept = async () => {
    const res = await acceptTrial(trialJob.id);
    if (res.success) {
      // status_changed → trial_accepted will also fire; either path lands on TrialActive.
      navigation.navigate('TrialActive');
    } else {
      // 409: "This trial offer has expired" → server already reset you to pending_trial.
      Alert.alert('Offer unavailable', res.message);
      refresh();
    }
  };

  const onDecline = async () => {
    await declineTrial(trialJob.id);
    // Server moves you back to pending_trial; router returns to TrialWaiting.
    refresh();
  };

  return (
    <View style={s.card}>
      <Text style={s.badge}>TRIAL JOB</Text>
      <Text style={s.timer}>{secondsLeft > 0 ? `${secondsLeft}s to respond` : 'Expiring…'}</Text>
      <Text style={s.category}>{trialJob.category} · {trialJob.subcategory}</Text>
      <Text style={s.desc}>{trialJob.jobDescription}</Text>
      <Text style={s.host}>{trialJob.host.name}</Text>
      <Text style={s.addr}>{trialJob.address}</Text>
      <Text style={s.when}>Scheduled: {new Date(trialJob.scheduledTime).toLocaleString()}</Text>
      <Text style={s.earning}>You'll earn ₹{trialJob.pricing.workerEarning}</Text>
      <Text style={s.note}>Trial rate — {trialJob.pricing.trialRatePercent}% of the normal ₹{trialJob.pricing.standardTotalPrice}</Text>
      <Button title="Accept trial" disabled={secondsLeft === 0} onPress={onAccept} />
      <Button title="Decline" color="#b00" onPress={onDecline} />
    </View>
  );
}
```

**Accept response** (`res.trialJob` now reveals the host phone):
```json
{ "success": true, "message": "Trial job accepted",
  "trialJob": { "id": "…", "status": "accepted", "host": { "name": "Demo Host", "phone": "9111111111" }, "…": "…" } }
```

**Expiry:** if the countdown hits 0 before accepting, the backend sweeper flips you to
`pending_trial` and pushes `worker:status_changed` → router returns to TrialWaiting.
Attempting to accept late returns `409 "This trial offer has expired"`.

---

### 4c. TrialActiveScreen — `trial_accepted` → `trial_in_progress`

Two sub-states on one screen: **Start** (when `accepted`), then **Complete** (when
`in_progress`). Host contact is now visible.

```jsx
import { startTrial, completeTrial } from '../services/trialApi';

function TrialActiveScreen({ navigation }) {
  const { trialJob, refresh } = useTrial();
  const [notes, setNotes] = useState('');
  const [photos, setPhotos] = useState([]); // uploaded URLs (reuse your existing checkout uploader)

  if (!trialJob) return <Loader />;
  const started = trialJob.status === 'in_progress';

  const onStart = async () => { await startTrial(trialJob.id); refresh(); };
  const onComplete = async () => {
    const res = await completeTrial(trialJob.id, { photos, notes });
    if (res.success) navigation.navigate('TrialSubmitted'); // status → trial_completed
    else Alert.alert('Error', res.message);
  };

  return (
    <View style={s.card}>
      <Text style={s.badge}>TRIAL JOB · {started ? 'IN PROGRESS' : 'ACCEPTED'}</Text>
      <Text style={s.category}>{trialJob.category} · {trialJob.subcategory}</Text>
      <Text style={s.desc}>{trialJob.jobDescription}</Text>
      <Text style={s.host}>{trialJob.host.name} · {trialJob.host.phone}</Text>
      <Text style={s.addr}>{trialJob.address}</Text>

      {!started ? (
        <Button title="Start job" onPress={onStart} />
      ) : (
        <>
          {/* Reuse the SAME checkout UI as normal jobs — photos + notes */}
          <PhotoUploader value={photos} onChange={setPhotos} />
          <TextInput placeholder="Notes (optional)" value={notes} onChangeText={setNotes} style={s.input} />
          <Button title="Complete job" onPress={onComplete} />
        </>
      )}
    </View>
  );
}
```

> `photos`/`notes` are optional and mirror your normal-job checkout payload. Upload
> images with your existing uploader and pass back the resulting URLs/paths.

---

### 4d. TrialSubmittedScreen — `trial_completed`

Job is done; the customer has been asked for feedback (SMS link). The worker just waits
for the decision. **Be honest about timing** — feedback can lag; the backend nudges the
customer and, if it takes hours, pushes a reassurance update.

```jsx
function TrialSubmittedScreen() {
  const { refresh } = useTrial();
  return (
    <View style={s.center}>
      <Text style={s.h1}>Trial complete ✅</Text>
      <Text style={s.body}>
        We've asked the customer for quick feedback. As soon as it's in, we'll review and
        let you know — usually within a few hours. You'll get a notification either way.
      </Text>
      <Button title="Check status" onPress={refresh} />
    </View>
  );
}
```

The next transition arrives as `worker:status_changed` with `status: 'approved'` or
`'rejected'` (auto from the decision engine, or from an admin's manual call for
`conditional` feedback). The router navigates automatically.

---

### 4e. TrialApprovedScreen / entering the main app — `approved`

`approved` is the same status the dispatch engine gates on, so the worker is now a full
worker. Route straight into the main app (Home / go-online). Optionally show a one-time
success interstitial:

```jsx
function TrialApprovedInterstitial({ navigation }) {
  return (
    <View style={s.center}>
      <Text style={s.h1}>You're approved! 🎉</Text>
      <Text style={s.body}>Your trial passed. You can now go online and accept jobs.</Text>
      <Button title="Go to Home" onPress={() => navigation.reset({ index: 0, routes: [{ name: 'Home' }] })} />
    </View>
  );
}
```

From here, the normal real-time dispatch flow in
[WORKER_APP_REALTIME_GUIDE.md](WORKER_APP_REALTIME_GUIDE.md) takes over (go online →
`job:offer` → accept → complete → rate).

---

### 4f. TrialRejectedScreen — `rejected`

```jsx
function TrialRejectedScreen() {
  return (
    <View style={s.center}>
      <Text style={s.h1}>Trial not approved</Text>
      <Text style={s.body}>
        Thanks for completing your trial. Unfortunately it wasn't approved this time.
        Our team will be in touch if there's a next step.
      </Text>
    </View>
  );
}
```

---

## 5. Real-time events (server → app)

These arrive on the **existing** worker socket (same room used for job offers):

| Event | Payload | App does |
|---|---|---|
| `trial:assigned` | `{ jobId, host{name,address,lat,lng}, scheduledTime, rate, offerExpiresAt }` | ring/vibrate, `refresh()`, land on TrialJobOfferScreen |
| `worker:status_changed` | `{ status, reason? }` | update `status`, `refresh()`, navigate via `screenForStatus(status)` |

`worker:status_changed` fires on **every** transition — accept, decline, start, complete,
offer timeout, decision engine result, and admin decision — so the UI stays in lockstep
with the backend with a single handler (§3).

Both events are also mirrored as a push notification (mock in dev, FCM in prod) so they
reach a backgrounded/killed app. Deep-link the push into `screenForStatus(status)` (or the
offer screen for `trial:assigned`), then `getTrialStatus()` once on open to hydrate.

---

## 6. App lifecycle & resume

- **On login / app open:** after `connectSocket()`, mount `<TrialProvider>`. Its initial
  `getTrialStatus()` returns the current `status` + `currentTrialJob`, so a worker who
  killed the app mid-trial resumes on the exact screen.
- **On `AppState` → `active`:** call `refresh()` (re-fetch trial status) in case a status
  change happened while the socket was asleep.
- **Offer screen specifically:** recompute the countdown from `offerExpiresAt` on resume —
  the offer may already have expired (server will have reset you to `pending_trial`).
- **Token expiry:** a socket `connect_error` "Invalid or expired token" → back to OTP login.

---

## 7. Edge cases to handle in UI

| Situation | Server behaviour | UI |
|---|---|---|
| Countdown hits 0 | Sweeper → `expired`, worker → `pending_trial`, `worker:status_changed` | auto-return to TrialWaiting |
| Accept after expiry | `409 "This trial offer has expired"` | toast + `refresh()` (router handles nav) |
| Worker declines | worker → `pending_trial` (logged as ops signal) | return to TrialWaiting |
| Complete with no photos | allowed (`photos`/`notes` optional) | don't block the button |
| Feedback is `conditional` | worker stays `trial_completed` (admin decides) | stay on TrialSubmitted |
| Feedback overdue (hours) | reassurance push to worker | copy already says "within a few hours" |

---

## 8. Endpoint & event reference (worker app)

**REST (worker JWT):**
| Method | Path | Screen |
|---|---|---|
| GET  | `/api/worker/trial/status` | seed/resume all trial screens |
| POST | `/api/worker/trial/:id/accept` | TrialJobOffer |
| POST | `/api/worker/trial/:id/decline` | TrialJobOffer |
| POST | `/api/worker/trial/:id/start` | TrialActive |
| POST | `/api/worker/trial/:id/complete` | TrialActive → TrialSubmitted |

**Socket (server → app):** `trial:assigned`, `worker:status_changed`
(plus the existing `jobs:open` / `job:offer` / `job:taken` / `job:expired` once `approved`).

**Precondition:** the worker reaches `pending_trial` only after an admin clears
application review. The customer feedback + decision (which drives the final
approved/rejected) happens outside the worker app — see
[TRIAL_JOB_GUIDE.md](TRIAL_JOB_GUIDE.md) for that side.
```
