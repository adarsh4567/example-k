# Kaaryo — Worker Onboarding Backend

Backend for the Kaaryo cleaning-worker onboarding flow. Built with **Node.js + Express** and **MongoDB (Atlas)**.

A worker is a **single MongoDB document** that grows as they move through the onboarding screens. Third-party services (SMS OTP, Aadhaar e-KYC, face match, Google Places) are **mocked behind clean service interfaces** in [`src/services/`](src/services/) — flip a toggle in `.env` and implement one function to go live.

---

## 1. Setup

```bash
npm install          # already done
npm run seed:admin   # creates the default admin (already done)
npm start            # starts the API
```

Server runs on **http://localhost:4000** (port 4000 because macOS Control Center occupies 5000).

> Dev mode with auto-reload: `npm run dev`

---

## 2. Environment (`.env`)

Everything is pre-filled. Key entries:

| Variable | Meaning |
|---|---|
| `PORT` | API port (default **4000**) |
| `MONGODB_URI` | Your Atlas connection string (points at the `kaaryo` DB) |
| `JWT_SECRET` / `ADMIN_JWT_SECRET` | Token signing secrets — **change to long random strings for production** |
| `MOCK_OTP` | Fixed OTP used in mock mode (**`123456`**) |
| `SMS_MODE` / `AADHAAR_MODE` / `FACE_MATCH_MODE` / `PLACES_MODE` | `mock` (default) or `real` |
| `FACE_MATCH_FORCE_FAIL` | `true` forces face-match failure to test the retry / manual-review path |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Seeded admin credentials |

**Default admin login:** `admin@kaaryo.com` / `Admin@123`

---

## 3. Going from mock → real

Each integration is one file with a clearly marked spot:

| Screen | Service file | Set in `.env` |
|---|---|---|
| 1 — Phone OTP | [`src/services/smsService.js`](src/services/smsService.js) | `SMS_MODE=real` (Twilio / MSG91 …) |
| 4 — Aadhaar | [`src/services/aadhaarService.js`](src/services/aadhaarService.js) | `AADHAAR_MODE=real` (UIDAI / IDfy / Signzy) |
| 5 — Face match | [`src/services/faceMatchService.js`](src/services/faceMatchService.js) | `FACE_MATCH_MODE=real` (HyperVerge / AWS Rekognition) |
| 3 — Localities | [`src/services/placesService.js`](src/services/placesService.js) | `PLACES_MODE=real` (Google Places) |

In mock mode: phone & Aadhaar OTP are always **`123456`**, Aadhaar returns a fixed demographic payload, and face-match returns success.

---

## 4. Authentication

- **Worker:** `POST /api/auth/verify-otp` returns a JWT. Send it as `Authorization: Bearer <token>` on all `/api/onboarding/*` routes.
- **Admin:** `POST /api/admin/login` returns a JWT. Send it as `Authorization: Bearer <token>` on all protected `/api/admin/*` routes.

---

## 5. API reference

### Screen 1 — Phone & OTP
| Method | Endpoint | Body |
|---|---|---|
| POST | `/api/auth/send-otp` | `{ phone }` |
| POST | `/api/auth/resend-otp` | `{ phone }` (30s cooldown enforced) |
| POST | `/api/auth/verify-otp` | `{ phone, otp }` → `{ token, isNewUser, worker }` |

### Screens 2–9 (worker JWT required)
| Screen | Method | Endpoint | Notes |
|---|---|---|---|
| 2 Personal | PUT | `/api/onboarding/personal` | **multipart**: `fullName, dob, gender, profilePhoto` (file). Age ≥ 18, photo mandatory. |
| 3 Location | PUT | `/api/onboarding/location` | `{ city, area, pincode, address, travelRadiusKm }` (1/2/5/10) |
| 3 Helpers | GET | `/api/places/cities` · `/api/places/suggest?city=&q=` | operating cities / locality auto-suggest |
| 4 Aadhaar | POST | `/api/onboarding/aadhaar/request-otp` | `{ aadhaarNumber }` |
| 4 Aadhaar | POST | `/api/onboarding/aadhaar/verify` | `{ aadhaarNumber, otp }` → returns name/DOB to confirm + `mobileMismatch` |
| 5 Face match | POST | `/api/onboarding/face-match` | **multipart**: `selfie` (file). 1 retry, then manual review. Score never returned. |
| 6 Work | PUT | `/api/onboarding/work-details` | `{ cleaningTypes[], experience, workedBefore, prevPlatform, ownsEquipment, equipmentList[], workingHours, workingDays }` |
| 7 References | PUT | `/api/onboarding/references` | `{ referenceConsent, references[{name, relationship, phone}] }` (1–2, unique, not self) |
| 8 Consent (e-sign) | POST | `/api/onboarding/consent/esign/request-otp` | Requires Aadhaar already verified (Screen 4). Mock OTP. |
| 8 Consent (e-sign) | POST | `/api/onboarding/consent/esign/verify` | `{ otp }` → marks e-sign verified server-side |
| 8 Consent | POST | `/api/onboarding/consent` | **multipart**: `backgroundCheck, infoAccurate`, plus either a `signature` file **or** a prior verified e-sign |
| 9 Submit | POST | `/api/onboarding/submit` | Locks app, returns referral code + next steps |
| — Status | GET | `/api/onboarding/status` | Progress tracker |

### Admin (admin JWT required)
| Method | Endpoint | Body |
|---|---|---|
| POST | `/api/admin/login` | `{ email, password }` |
| GET | `/api/admin/workers?status=submitted&page=1&limit=20` | review queue |
| GET | `/api/admin/workers/:id` | full application |
| POST | `/api/admin/workers/:id/move-to-review` | submitted → under_review |
| POST | `/api/admin/workers/:id/approve` | `{ message? }` → notifies worker |
| POST | `/api/admin/workers/:id/reject` | `{ reason }` (required) → notifies worker |
| POST | `/api/admin/workers/:id/request-info` | `{ message }` (the "something missing" case) |

---

## 6. Application lifecycle

```
in_progress → submitted → under_review → approved
                        ↘ manual_review ↗ rejected
                        ↘ info_requested
```

- Worker fills screens while `in_progress`. Screens are locked once `submitted`.
- Face-match failing twice auto-sets `manual_review`.
- `submit` verifies every prior screen is complete before accepting.
- Approve / reject / request-info are logged in `reviewLog[]` with the admin's email + timestamp, and fire a (mock) SMS + push notification to the worker.

Applications **do not go live automatically** — they enter the admin review queue (`GET /api/admin/workers?status=submitted`).

---

## 7. Notable field enums

- **cleaningTypes:** `basic_home, kitchen, bathroom, deep_cleaning, sofa_carpet, office_commercial, post_construction`
- **experience:** `lt_1, 1_3, 3_5, gt_5`
- **workingHours:** `morning, afternoon, evening, flexible`
- **workingDays:** `weekdays, weekends, all_days`
- **equipmentList:** `mop, broom, bucket, cleaning_cloth, scrubbing_brush`
- **reference relationship:** `past_employer, neighbor, known_family, other`
- **gender:** `male, female, prefer_not_to_say`

---

## 8. Project layout

```
server.js               entry point (npm start)
.env                    config
uploads/                stored selfies / photos / signatures
src/
  config/db.js          Mongo connection
  models/               Worker, Otp, Admin
  middleware/           auth, adminAuth, upload (multer), errorHandler
  services/             smsService, aadhaarService, faceMatchService, placesService, notificationService
  controllers/          auth, onboarding, places, admin
  routes/               authRoutes, onboardingRoutes, placesRoutes, adminRoutes
  scripts/seedAdmin.js  creates default admin
  utils/                validators, response helpers
```
