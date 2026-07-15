# Kaaryo Worker App — Frontend Integration Guide

Base URL: `http://16.112.18.34:4000`
All responses follow the same envelope:

```json
// success
{ "success": true, "message": "...", ...extraFields }
// failure
{ "success": false, "message": "...", ...extraFields }
```

HTTP status codes used: `200` OK, `400` bad request / business rule failure, `401` auth failure, `409` conflict (e.g. editing a locked app), `422` validation error, `429` rate limited (OTP cooldown), `500` server error.

## Auth headers

| Route group | Header |
|---|---|
| `/api/onboarding/*` | `Authorization: Bearer <worker_token>` (from Screen 1 verify-otp) |
| `/api/admin/*` (except `/login`) | `Authorization: Bearer <admin_token>` (from admin login — not used by the worker app) |
| `/api/auth/*`, `/api/places/*` | none |

Store the worker token in secure storage after Screen 1 and attach it to every request from Screen 2 onward. A `401` means the token is missing/expired — send the user back to Screen 1.

Content types: JSON endpoints use `Content-Type: application/json`. Endpoints that upload a photo/selfie/signature use `multipart/form-data`.

---

## SCREEN 1 — Phone Number & OTP

### `POST /api/auth/send-otp`
Request:
```json
{ "phone": "9876543210" }
```
Success `200`:
```json
{ "success": true, "message": "OTP sent successfully", "cooldownSeconds": 30 }
```
Use `cooldownSeconds` to drive the "Resend OTP" 30s timer.

Errors:
- `422` — invalid phone (must be 10 digits, starting 6-9)
- `429` — resent too soon: `{ "success": false, "message": "Please wait 18s before requesting a new OTP" }`

### `POST /api/auth/resend-otp`
Identical contract to `send-otp`. Call after the 30s timer elapses.

### `POST /api/auth/verify-otp`
Request:
```json
{ "phone": "9876543210", "otp": "123456" }
```
Success `200`:
```json
{
  "success": true,
  "message": "New account created",
  "token": "eyJhbGciOi...",
  "isNewUser": true,
  "worker": {
    "id": "6a550a5e4d3dd6f5070a28b2",
    "phone": "9876543210",
    "status": "in_progress",
    "onboardingStep": "phone",
    "fullName": null
  }
}
```
- `message` is `"Welcome back"` and `isNewUser: false` when the phone already has an account.
- **Redirect logic:** use `worker.status` + `worker.onboardingStep` to route:
  - `status: "in_progress"` → resume at `onboardingStep` (see step→screen map below)
  - `status: "submitted" | "under_review" | "manual_review" | "info_requested"` → go straight to the Screen 9 tracker (call `GET /api/onboarding/status`)
  - `status: "approved" | "rejected"` → show final outcome screen

| `onboardingStep` value | Resume at screen |
|---|---|
| `phone` | Screen 2 |
| `personal` | Screen 3 |
| `location` | Screen 4 |
| `aadhaar` | Screen 5 |
| `face_match` | Screen 6 |
| `work_details` | Screen 7 |
| `references` | Screen 8 |
| `consent` | Screen 9 (submit) |
| `submitted` | Screen 9 (tracker) |

Errors:
- `422` — invalid phone/OTP format
- `400` — `"OTP expired or not requested. Please request a new one"` / `"Incorrect OTP"`

> Auto-detect note: OTP autofill via SMS Retriever/RCS is purely a client-side (device) capability — no backend change needed. If you want the OTP embedded in a predictable app-hash format for Android autofill, tell me the app hash and I'll adjust the mock SMS body.

---

## SCREEN 2 — Basic Personal Details

`PUT /api/onboarding/personal` — **multipart/form-data**, requires worker token.

| Field | Type | Notes |
|---|---|---|
| `fullName` | text | required |
| `dob` | text | `YYYY-MM-DD`, must yield age ≥ 18 |
| `gender` | text | one of `male`, `female`, `prefer_not_to_say` |
| `profilePhoto` | file | **required**, live selfie image (front camera capture, no gallery) |

Success `200`:
```json
{
  "success": true,
  "message": "Personal details saved",
  "profilePhoto": "/uploads/profilePhoto_6a55.._552253375.jpg",
  "onboardingStep": "location"
}
```
Prepend the server base URL to `profilePhoto` to render the preview (`http://localhost:4000/uploads/...`).

Errors (`422`):
- `"Full name is required"` / `"Date of birth is required"` / `"Invalid date of birth"`
- `"You must be at least 18 years old to register"` — show this inline, do not let them proceed
- `"Gender must be male, female, or prefer_not_to_say"`
- `"Profile photo (live selfie) is required"`

---

## SCREEN 3 — Location Details

### Helper: `GET /api/places/cities` (no auth)
```json
{ "success": true, "message": "Operating cities", "cities": ["Bengaluru", "Mumbai", "Delhi", "Pune", "Hyderabad"] }
```
Populate the city dropdown from this — don't hardcode it client-side.

### Helper: `GET /api/places/suggest?city=Bengaluru&q=kor` (no auth)
```json
{ "success": true, "message": "Locality suggestions", "suggestions": ["Koramangala"] }
```
Call on every keystroke in the locality field (debounce ~300ms) once a city is picked. `q` is optional — omit it to get the full list for that city.

### `PUT /api/onboarding/location` — JSON, requires worker token
Request:
```json
{
  "city": "Bengaluru",
  "area": "Koramangala",
  "pincode": "560095",
  "address": "12 Main Rd, 2nd Cross",
  "travelRadiusKm": 5
}
```
`travelRadiusKm` must be one of `1, 2, 5, 10` (render as a radio/segmented selector, not free text).

Success `200`:
```json
{
  "success": true,
  "message": "Location saved",
  "location": { "city": "Bengaluru", "area": "Koramangala", "pincode": "560095", "address": "12 Main Rd, 2nd Cross", "travelRadiusKm": 5 },
  "onboardingStep": "aadhaar"
}
```
Errors (`422`): invalid city / missing area / invalid 6-digit pincode / missing address / invalid radius.

---

## SCREEN 4 — Aadhaar Verification

### `POST /api/onboarding/aadhaar/request-otp` — JSON, requires worker token
Request:
```json
{ "aadhaarNumber": "111122223333" }
```
Success `200`:
```json
{ "success": true, "message": "OTP sent to Aadhaar-linked mobile number", "refId": "mock-aadhaar-3333" }
```
Hold onto `refId` and send it back on verify (optional, currently unused by mock but keep the field for when the real UIDAI/KYC partner is wired in).

Errors: `422` invalid Aadhaar (must be 12 digits).

### `POST /api/onboarding/aadhaar/verify` — JSON, requires worker token
Request:
```json
{ "aadhaarNumber": "111122223333", "otp": "123456", "refId": "mock-aadhaar-3333" }
```
Success `200`:
```json
{
  "success": true,
  "message": "Aadhaar verified successfully",
  "confirmDetails": { "name": "Test Kaaryo Worker", "dob": "1995-06-15" },
  "mobileMismatch": false,
  "onboardingStep": "face_match"
}
```
- Show `confirmDetails.name` / `confirmDetails.dob` to the user and ask them to confirm (per spec, auto-filled from Aadhaar).
- If `mobileMismatch: true`, `message` becomes `"Aadhaar verified. Note: your Aadhaar-linked mobile differs from your registered number."` — display this as an informational banner, do not block progress.

Errors (`400`): `"Invalid Aadhaar OTP"` / `"Aadhaar verification failed"`.

> This step must complete before Screen 5 and before the Screen 8 e-sign option will work.

---

## SCREEN 5 — Face Match / Live Selfie Verification

`POST /api/onboarding/face-match` — **multipart/form-data**, requires worker token.

| Field | Type | Notes |
|---|---|---|
| `selfie` | file | required, live camera capture |

Success `200`:
```json
{ "success": true, "message": "Face verified successfully", "onboardingStep": "work_details" }
```

**Failure — first attempt** (`400`):
```json
{
  "success": false,
  "message": "Face did not match. Please retry — remove glasses, ensure good lighting, look straight at the camera.",
  "retryAllowed": true,
  "attempts": 1
}
```
Show the message as on-screen instructions and let the user retake + resubmit to the same endpoint.

**Failure — second attempt** (`200`, not an error — app should treat this as a soft terminal state):
```json
{ "success": true, "message": "We could not verify your photo. Your application has been sent for manual review.", "manualReview": true }
```
Show "Your application is under manual review" and route to the Screen 9 tracker; do not offer another retry.

Other errors: `400` if Aadhaar isn't verified yet, `422` if no file attached.

> The numeric match score is intentionally never returned — only success/fail.

---

## SCREEN 6 — Work Details & Skill Selection

`PUT /api/onboarding/work-details` — JSON, requires worker token.

Request:
```json
{
  "cleaningTypes": ["basic_home", "kitchen"],
  "experience": "1_3",
  "workedBefore": true,
  "prevPlatform": { "name": "UrbanCo", "duration": "2 years" },
  "ownsEquipment": true,
  "equipmentList": ["mop", "bucket"],
  "workingHours": "flexible",
  "workingDays": "all_days"
}
```

Enum reference for building the UI:

| Field | Allowed values |
|---|---|
| `cleaningTypes[]` (multi-select, ≥1 required) | `basic_home`, `kitchen`, `bathroom`, `deep_cleaning`, `sofa_carpet`, `office_commercial`, `post_construction` |
| `experience` | `lt_1`, `1_3`, `3_5`, `gt_5` |
| `workingHours` | `morning`, `afternoon`, `evening`, `flexible` |
| `workingDays` | `weekdays`, `weekends`, `all_days` |
| `equipmentList[]` | `mop`, `broom`, `bucket`, `cleaning_cloth`, `scrubbing_brush` |

- `prevPlatform` is **required** only when `workedBefore: true`.
- `equipmentList` is only read when `ownsEquipment: true`; send `[]` or omit otherwise.

Success `200`:
```json
{
  "success": true,
  "message": "Work details saved",
  "work": { "...": "echoes back everything saved" },
  "onboardingStep": "references"
}
```

Errors (`422`): missing/invalid cleaning type, experience, hours, or days; missing `prevPlatform.name` when `workedBefore` is true; invalid equipment item.

---

## SCREEN 7 — Reference Details

`PUT /api/onboarding/references` — JSON, requires worker token.

Request:
```json
{
  "referenceConsent": true,
  "references": [
    { "name": "Suresh Rao", "relationship": "past_employer", "phone": "9000000001" },
    { "name": "Anita Sharma", "relationship": "neighbor", "phone": "9000000002" }
  ]
}
```
- `relationship` ∈ `past_employer`, `neighbor`, `known_family`, `other`
- 1–2 references. Second one is optional but encouraged (per spec).
- Server rejects: a reference phone equal to the worker's own registered number, and duplicate phone numbers between the two references.
- `referenceConsent` must be `true` to proceed.

Success `200`:
```json
{
  "success": true,
  "message": "References saved",
  "references": [ ... ],
  "onboardingStep": "consent"
}
```

Errors (`422`): `"You must allow Kaaryo to contact your references"`, `"At least one reference is required"`, `"You can add at most two references"`, per-reference name/relationship/phone errors, `"Reference N: cannot be your own registered number"`, `"The two references cannot have the same phone number"`.

---

## SCREEN 8 — Background Check Consent

Two consent checkboxes plus a signature. **Demo note:** since we don't have a real UIDAI e-sign integration, e-sign here is a mocked OTP flow — behaviorally similar to the real thing but not wired to UIDAI. Offer the user **either** path:

### Option A — Signature pad
Draw on a canvas, export as an image, then submit directly (see final step below) with that image as `signature`.

### Option B — "e-Sign with Aadhaar" (mock)

**Step 1: `POST /api/onboarding/consent/esign/request-otp`** — no body, requires worker token. Requires Aadhaar (Screen 4) already verified.
```json
{ "success": true, "message": "OTP sent to your Aadhaar-linked mobile for e-sign" }
```
Error `400`: `"Complete Aadhaar verification (Screen 4) before e-signing"`.

**Step 2: `POST /api/onboarding/consent/esign/verify`** — JSON, requires worker token.
```json
{ "otp": "123456" }
```
Success `200`: `{ "success": true, "message": "Aadhaar e-sign verified. You can now submit your consent." }`
Error `400`: `{ "success": false, "message": "Invalid e-sign OTP" }`

Once verified, the server remembers it — the final submit call below needs **no signature file**.

### Final step (both options): `POST /api/onboarding/consent` — **multipart/form-data**, requires worker token

| Field | Type | Notes |
|---|---|---|
| `backgroundCheck` | text (`"true"`/`"false"`) | consent checkbox 1, required `true` |
| `infoAccurate` | text (`"true"`/`"false"`) | consent checkbox 2, required `true` |
| `signature` | file | **required only if you did NOT complete the e-sign OTP flow above** |

Success `200`:
```json
{ "success": true, "message": "Consent recorded", "signedAt": "2026-07-13T16:00:57.205Z", "onboardingStep": "submitted" }
```

Errors (`422`): `"You must consent to the background verification check"`, `"You must confirm that your information is accurate and true"`, `"A digital signature (upload) or Aadhaar e-sign (via /consent/esign/verify) is required"`.

---

## SCREEN 9 — Application Submitted

### `POST /api/onboarding/submit` — no body, requires worker token

Success `200`:
```json
{
  "success": true,
  "message": "Congratulations Ramesh Kumar! Your application has been submitted.",
  "name": "Ramesh Kumar",
  "referralCode": "KAARYO-0A28B2",
  "nextSteps": [
    { "step": 1, "title": "Application review", "eta": "24 to 48 hours" },
    { "step": 2, "title": "References contacted", "eta": "" },
    { "step": 3, "title": "Background verification", "eta": "2 to 3 working days" },
    { "step": 4, "title": "Approval / rejection notification (app + SMS)", "eta": "" }
  ]
}
```
Use `nextSteps` to render the "what happens next" list directly — no need to hardcode copy client-side. `referralCode` powers the share/referral button.

Error `400` if a screen was skipped:
```json
{ "success": false, "message": "Please complete: Aadhaar verification, references", "missing": ["Aadhaar verification", "references"] }
```
Error `409` if already submitted: `"Application already submitted"`.

### `GET /api/onboarding/status` — no body, requires worker token
Call this on app open (if `status !== 'in_progress'`) to drive the progress tracker.
```json
{
  "success": true,
  "message": "Status fetched",
  "status": "submitted",
  "onboardingStep": "submitted",
  "progress": {
    "personal": true,
    "location": true,
    "aadhaar": true,
    "faceMatch": "success",
    "workDetails": true,
    "references": true,
    "consent": true,
    "submitted": true
  },
  "referralCode": "KAARYO-0A28B2",
  "submittedAt": "2026-07-13T16:00:57.205Z"
}
```

`status` drives which tracker stage to highlight:

| `status` | Meaning | UI |
|---|---|---|
| `in_progress` | still onboarding | shouldn't reach Screen 9 |
| `submitted` | just submitted, admin hasn't started review | Step 1 highlighted |
| `under_review` | admin pulled it into active review | Step 1 complete, Step 2/3 in progress |
| `manual_review` | face-match failed twice, or admin flagged it | show "under manual review", no ETA promises |
| `info_requested` | admin needs something more | show the request; **check the latest entry in reviewLog if you expose it, or add a dedicated worker-facing endpoint if you want the message surfaced — currently only visible via SMS/push** |
| `approved` | done | success screen |
| `rejected` | done | rejection screen |

> Note: `info_requested` and rejection reasons are currently only pushed to the worker via the (mocked) SMS/push notification, not re-fetchable via `GET /status`. If you want the frontend to display the admin's message in-app (not just via SMS), let me know and I'll add the latest `reviewLog` message to this response.

---

## Quick reference — all endpoints

| Screen | Method | Path | Auth |
|---|---|---|---|
| 1 | POST | `/api/auth/send-otp` | none |
| 1 | POST | `/api/auth/resend-otp` | none |
| 1 | POST | `/api/auth/verify-otp` | none |
| 2 | PUT | `/api/onboarding/personal` | worker |
| 3 | GET | `/api/places/cities` | none |
| 3 | GET | `/api/places/suggest` | none |
| 3 | PUT | `/api/onboarding/location` | worker |
| 4 | POST | `/api/onboarding/aadhaar/request-otp` | worker |
| 4 | POST | `/api/onboarding/aadhaar/verify` | worker |
| 5 | POST | `/api/onboarding/face-match` | worker |
| 6 | PUT | `/api/onboarding/work-details` | worker |
| 7 | PUT | `/api/onboarding/references` | worker |
| 8 | POST | `/api/onboarding/consent/esign/request-otp` | worker |
| 8 | POST | `/api/onboarding/consent/esign/verify` | worker |
| 8 | POST | `/api/onboarding/consent` | worker |
| 9 | POST | `/api/onboarding/submit` | worker |
| 9 | GET | `/api/onboarding/status` | worker |
| Profile | GET | `/api/profile` | worker |
| Profile | GET | `/api/profile/catalog` | worker |
| Profile | PUT | `/api/profile/expertise` | worker |
| Profile | PUT | `/api/profile` | worker |
| Dispatch | POST | `/api/service-requests` | none (customer) |
| Dispatch | GET | `/api/service-requests/:id` | none (customer) |
| Dispatch | POST | `/api/service-requests/:id/cancel` | none (customer) |
| Dispatch | PUT | `/api/jobs/availability` | worker |
| Dispatch | GET | `/api/jobs/available` | worker |
| Dispatch | GET | `/api/jobs/mine` | worker |
| Dispatch | POST | `/api/jobs/:id/accept` | worker |
| Dispatch | POST | `/api/jobs/:id/decline` | worker |
| Dispatch | POST | `/api/jobs/:id/complete` | worker |

Mock OTP for **all** OTP steps (phone, Aadhaar, e-sign) during development: **`123456`**.

---

## ON-DEMAND SERVICE REQUESTS (dispatch engine)

A customer requests a service → the backend broadcasts it to the nearest eligible **online, approved** workers within a radius → the first to accept wins → the job goes **in_progress**. If nobody accepts before the wave times out, the radius expands automatically; if the max radius is reached, the request expires.

**Worker eligibility to receive an offer:** `status = approved`, `availability.isOnline = true`, not already on a job, offers the requested category (via profile expertise or legacy cleaning types), within the current search radius, **and the job is within the worker's own onboarding travel radius** (`location.travelRadiusKm` — 1/2/5/10 km). A worker who chose "2 km" is never offered a job 5 km away, even as the search radius expands.

### Real-time delivery (Socket.IO) — no polling

Offers are **pushed live to the worker over a Socket.IO connection**. The worker app does **not** poll `/api/jobs/available` — that endpoint remains only as a fallback/snapshot. The worker holds one authenticated socket and reacts to events.

**Connect** (pass the worker JWT in the handshake):
```js
import { io } from 'socket.io-client';
const socket = io('http://localhost:4000', { auth: { token: WORKER_JWT } });
```

**Server → worker events:**
| Event | Payload | Meaning |
|---|---|---|
| `jobs:open` | `{ jobs: [offer] }` | snapshot of offers already open to you, sent once on connect |
| `job:offer` | `offer` | a new job was just dispatched to you (show it, start your accept timer) |
| `job:taken` | `{ id }` | another worker took a job you were offered — remove it from the UI |
| `job:expired` | `{ id }` | a job you were offered expired with no taker — remove it |

`offer` shape: `{ id, category, subcategory, address, distanceKm, customerName, status, wave, offeredAt }` (customer phone hidden until accept).

**Worker → server events** (each takes an ack callback):
| Emit | Payload | Ack response |
|---|---|---|
| `job:accept` | `{ requestId }` | `{ ok: true, job: {…customer contact revealed…} }` or `{ ok: false, message }` |
| `job:decline` | `{ requestId }` | `{ ok: true }` or `{ ok: false, message }` |
| `presence:update` | `{ isOnline?, lat?, lng? }` | `{ ok: true, availability }` — set online state + live location over the socket |

```js
socket.on('job:offer', (offer) => showOffer(offer));
socket.on('job:taken', ({ id }) => removeOffer(id));
socket.emit('job:accept', { requestId }, (res) => {
  if (res.ok) openJob(res.job);        // customer name + phone now present
  else toast(res.message);             // e.g. "This job is no longer available"
});
```

Test it without the app using the bundled CLI client: `npm run worker-client -- <WORKER_JWT>` (see the end of this section).

### Worker side (REST — for availability, history, and as a socket fallback)

**`PUT /api/jobs/availability`** — go online/offline + send live location (heartbeat). A worker only receives offers while online with a location set. (Equivalent to the socket `presence:update` event.)
```json
{ "isOnline": true, "lat": 12.9352, "lng": 77.6245 }
```
→ `{ "success": true, "message": "Availability updated", "availability": { "isOnline": true, "lastSeenAt": "...", "location": { "type": "Point", "coordinates": [77.6245, 12.9352] } } }`

**`GET /api/jobs/available`** — fallback snapshot of open offers (the socket `jobs:open`/`job:offer` events are the primary path; **do not poll this**).
```json
{ "success": true, "jobs": [ { "id": "...", "category": "cleaning", "subcategory": "kitchen", "address": "…", "distanceKm": 1.4, "customerName": "Riya", "status": "searching", "wave": 1, "offeredAt": "…" } ] }
```
> Customer phone is hidden until the worker accepts.

**`POST /api/jobs/:id/accept`** — REST equivalent of the `job:accept` socket event. First-to-accept-wins.
- Success `200`: `{ "success": true, "message": "Job accepted — you are now in progress", "job": { "id": "...", "status": "in_progress", "customer": { "name": "Riya", "phone": "9800000000" }, "address": "…", "location": {...}, "acceptedAt": "…" } }` (customer contact now revealed)
- Conflict `409`: `"This job is no longer available (already taken or expired)"` or `"You already have an active job. Complete it first."`

**`POST /api/jobs/:id/decline`** — decline an offer → `200`.

**`GET /api/jobs/mine`** — `{ "active": [ ... in_progress jobs ... ], "history": [ ... completed/cancelled ... ] }`.

**`POST /api/jobs/:id/complete`** — assigned worker marks the job done → status `completed`, worker freed, `jobsCompleted` incremented (feeds the profile card). `403` if not assigned to you, `409` if not in_progress.

### Customer side (no auth for now — fire directly)

**`POST /api/service-requests`**
```json
{
  "customerName": "Riya",
  "customerPhone": "9800000000",
  "category": "cleaning",
  "subcategory": "kitchen",
  "lat": 12.9352,
  "lng": 77.6245,
  "address": "Flat 5B, HSR Layout",
  "radiusKm": 3
}
```
- `subcategory` and `radiusKm` are optional (radius defaults to `DISPATCH_INITIAL_RADIUS_KM`).
- Success `201`: `{ "success": true, "message": "Request created — notified N nearby worker(s)...", "workersNotified": N, "request": { "id": "...", "status": "searching", "radiusKm": 3, "wave": 1, "workersNotified": N, ... } }`
- Errors `422`: missing/invalid name, phone, category, subcategory, or lat/lng.

**`GET /api/service-requests/:id`** — customer polls for live status.
```json
{
  "success": true,
  "request": {
    "id": "...",
    "status": "in_progress",
    "category": "cleaning",
    "subcategory": "kitchen",
    "radiusKm": 3,
    "wave": 1,
    "workersNotified": 4,
    "worker": { "id": "...", "name": "Kiran Kumar", "phone": "9876543210", "rating": null, "jobsCompleted": 3, "distanceKm": 1.4 },
    "acceptedAt": "…"
  }
}
```
`status` transitions: `searching` → `in_progress` (accepted) → `completed`; or `cancelled` / `expired`. Worker details appear once `in_progress`.

**`POST /api/service-requests/:id/cancel`** — cancel a `searching` or `in_progress` request (frees the worker). `409` if already completed/cancelled/expired.

### Tunables (`.env`)
`DISPATCH_INITIAL_RADIUS_KM` (3), `DISPATCH_RADIUS_INCREMENT_KM` (3), `DISPATCH_MAX_RADIUS_KM` (15), `DISPATCH_BATCH_SIZE` (10), `DISPATCH_WAVE_TIMEOUT_SECONDS` (30), `DISPATCH_SWEEP_INTERVAL_SECONDS` (5).

### Testing the real-time flow manually
1. Start the server: `npm start`
2. In another terminal, connect a worker socket (stands in for the app):
   `npm run worker-client -- <WORKER_JWT>`  (add `AUTO_ACCEPT=1` env to auto-accept the first offer)
3. Make sure that worker is **approved** and **online with a location** — the client can do this, or call `PUT /api/jobs/availability`.
4. Fire a customer request near that location: `POST /api/service-requests`.
5. Watch the `job:offer` land in the client instantly; type `a <requestId>` to accept. Connect a second worker client to see the loser get `job:taken`.

---

## PROFILE SCREEN (post-onboarding, editable anytime)

All profile endpoints require the worker JWT and work in **any** application status (unlike onboarding, which locks after submit).

### `GET /api/profile`
Returns everything the profile screen renders in one payload.
```json
{
  "success": true,
  "message": "Profile fetched",
  "profile": {
    "id": "6a55...",
    "fullName": "Kiran Kumar",
    "displayInitial": "K",
    "profilePhoto": "/uploads/profilePhoto_....jpg",
    "photoUrl": "/uploads/profilePhoto_....jpg",
    "city": "Bengaluru",
    "serviceArea": "Bengaluru",
    "phone": "9876543210",
    "phoneFormatted": "+91 98765 43210",
    "rating": null,
    "jobsCompleted": 0,
    "status": "approved",
    "expertise": [
      {
        "category": "cleaning",
        "name": "Cleaning",
        "color": "#3b82f6",
        "active": true,
        "subcategories": [
          { "key": "basic_home", "name": "Basic home cleaning", "active": true },
          { "key": "kitchen", "name": "Kitchen cleaning", "active": true },
          { "key": "bathroom", "name": "Bathroom cleaning", "active": false }
        ]
      },
      {
        "category": "electrical",
        "name": "Electrical",
        "color": "#f59e0b",
        "active": false,
        "subcategories": [ { "key": "wiring", "name": "Wiring & repair", "active": false } ]
      }
    ],
    "account": { "serviceArea": "Bengaluru", "phone": "+91 98765 43210" }
  }
}
```
Rendering notes:
- **Profile card:** use `displayInitial` for the avatar when `photoUrl` is null; prepend the API base URL to `photoUrl` otherwise. `rating: null` → show "New" (no ratings yet). `jobsCompleted` → "N Jobs Done".
- **My Expertise:** `expertise` already contains **all 8 categories merged with the worker's selections**. Render a category as an active card (color + check) when `category.active === true`, else as an available card (`+`). Tapping a card expands its `subcategories`; each has its own `active` flag to drive the sub-toggles.
- **Account:** `account.serviceArea` and `account.phone` are pre-formatted for display.

### `GET /api/profile/catalog`
The raw catalog (all categories + subcategories + colors), if you prefer to render the picker from the catalog instead of the merged `expertise`.
```json
{ "success": true, "message": "Service catalog", "catalog": [ { "key": "cleaning", "name": "Cleaning", "color": "#3b82f6", "subcategories": [ { "key": "basic_home", "name": "Basic home cleaning" } ] } ] }
```

### `PUT /api/profile/expertise` — JSON
Send the **full desired state** (not a delta). Categories with no subcategories are dropped (i.e. that's how you turn a whole category off).
```json
{
  "expertise": [
    { "category": "cleaning", "subcategories": ["basic_home", "kitchen"] },
    { "category": "electrical", "subcategories": ["wiring"] }
  ]
}
```
Success `200` returns the same shape as `GET /api/profile` (`{ profile: {...} }`) with the updated expertise. The `cleaning` category is mirrored back into onboarding `work.cleaningTypes` automatically.

Errors (`422`): `"expertise must be an array..."`, `"Invalid service category: X"`, `"Invalid subcategory \"X\" for category \"Y\""`, `"Duplicate category in request: X"`.

### `PUT /api/profile` — multipart/form-data (the "Edit" button)
All fields optional; send only what changed.

| Field | Type | Notes |
|---|---|---|
| `fullName` | text | non-empty if sent |
| `city` | text | must be an operating city (see `/api/places/cities`) — updates Service Area |
| `profilePhoto` | file | new avatar image |

Success `200` returns `{ profile: {...} }` (same shape as `GET /api/profile`).
Errors (`422`): `"Full name cannot be empty"`, `"Service area must be one of: ..."`.

> Phone is the login identity and is **not** editable here. Rating and jobsCompleted are platform-managed (set as the worker completes jobs), not editable via these endpoints.
