# Kaaryo backend — master documentation

This is the only project documentation. It covers architecture, setup, deployment, data design, endpoint inventory, realtime contracts, operations, and capacity limits.

## Launch verdict

The codebase is suitable for roughly 10,000 registered users with moderate traffic when MongoDB is correctly indexed and media is stored in Cloudinary. It is not sized for 10,000 simultaneous users or WebSocket connections on one Render free instance.

Render currently gives a free web instance 0.1 CPU and 512 MB RAM, spins it down after 15 minutes without incoming HTTP requests or WebSocket messages, and explicitly says free instances should not be used for production. Free services also have no persistent disk. See [Render free-instance limits](https://render.com/docs/free), [compute plans](https://render.com/docs/compute-plans), and [WebSockets on Render](https://render.com/docs/websocket).

Use the free plan for a controlled beta. Before a public launch that promises consistently low latency, move to at least a paid always-on instance and load-test the real deployment. Cold starts make a universal latency guarantee impossible on free tier.

## What the system does

Kaaryo has three audiences:

- Customers authenticate by phone OTP, maintain a profile/address book/reward wallet, book normal services or discounted trials, track workers, pay, and submit trial feedback.
- Workers complete identity and skills onboarding, become eligible through a trial or electrical-shop assessment, advertise availability, accept work, stream location, complete jobs, and view earnings.
- Admins review applications/videos/trials/assessments, manage partner shops and slots, make decisions, and record payouts.

The backend runtime is one Node.js/Express process with Socket.IO. MongoDB is the system of record. Cloudinary holds videos and, in production, all images. The static admin control center deploys separately to Vercel and calls the Render API. Four in-process sweepers advance time-based dispatch, trial, assessment, and video-review work.

```text
customer app ─ REST + Socket.IO ─┐
worker app   ─ REST + Socket.IO ─┼─ Express/Socket.IO ─ MongoDB
admin on Vercel ─ REST ─────────┘          │
                                            ├─ Cloudinary
                                            ├─ SMS / WhatsApp
                                            └─ payment / identity providers
```

## Repository map

| Path | Responsibility |
| --- | --- |
| `server.js` | Process boot, middleware, health checks, routes, Socket.IO, sweepers, shutdown |
| `src/models` | MongoDB schemas, state enums, and indexes |
| `src/controllers` | HTTP transport and request validation |
| `src/services` | Dispatch, trials, payments, assessment, storage, rewards, notifications |
| `src/realtime` | Socket authentication, rooms, snapshots, and events |
| `src/routes` | Route definitions and auth placement |
| `src/middleware` | Auth, uploads, rate limits, errors, request timing |
| `src/config` | Database and business-policy configuration |
| `src/scripts` | Seeds, checks, repair tools, and index installation |
| `admin.html` | Source for the Vercel-hosted admin control center |
| `vercel.json` | Admin build/output and security headers |

## Local setup

Requirements: Node.js 20 or newer and MongoDB.

```bash
npm ci
cp .env.example .env
npm run db:indexes
npm test
npm run dev
```

The API defaults to `http://localhost:5000`. Health endpoints are `/health/live` and `/health/ready`. In a second terminal, preview the admin against that API:

```bash
ADMIN_API_BASE_URL=http://localhost:5000 npm run preview:admin
```

Open `http://127.0.0.1:4173`. Use `npm start` instead of `npm run dev` to run without file watching.

Never commit `.env`. It is ignored by Git. Rotate any credential that has ever been copied into chat, logs, screenshots, or source control.

## Environment configuration

Production boot requires `MONGODB_URI`, `JWT_SECRET`, and a different `ADMIN_JWT_SECRET`. Both secrets must be at least 32 characters. Production also refuses mock SMS, mock payments, or local/mock image storage unless `ALLOW_INSECURE_PRODUCTION=true`; that override is only for a demo.

| Group | Variables |
| --- | --- |
| Runtime | `NODE_ENV`, `PORT`, `PUBLIC_BASE_URL`, `CORS_ORIGINS`, `JSON_BODY_LIMIT`, `FORM_BODY_LIMIT`, `SLOW_REQUEST_MS` |
| MongoDB | `MONGODB_URI`, `MONGODB_MAX_POOL_SIZE`, idle/selection/socket/heartbeat timeout variables |
| Auth | `JWT_SECRET`, `ADMIN_JWT_SECRET`, `JWT_EXPIRES_IN`, `ADMIN_JWT_EXPIRES_IN`, OTP expiry/cooldown/attempt variables, `SMS_MODE`, `MOCK_OTP` |
| Media | `CLOUDINARY_MODE`, `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, delivery URL TTL, video limits |
| Admin build | `ADMIN_API_BASE_URL` (the public Render origin, with no trailing slash) |
| Providers | `PAYMENT_MODE`, `PAYMENT_PROVIDER`, `AADHAAR_MODE`, `FACE_MATCH_MODE`, `PLACES_MODE`, `WHATSAPP_MODE`, `PAYOUT_MODE`, `SLACK_WEBHOOK_URL` |
| Dispatch | Search radii, batch size, wave/search/sweep timeouts, and max attempts |
| Tracking | Arrival radii, ETA/speed/route factors, ping interval, accuracy/staleness limits, start requirement |
| Trials | Enable flags, prices/reward, category, candidate/radius/allowance limits, offer/feedback/sweep timing |
| Assessments | Enable/category, slot/check-in/cancellation/no-show policies, payouts, quality thresholds and timing |
| Rewards | Referral enable/amounts and support contact fields |

`ENABLE_LEGACY_PUBLIC_REQUESTS` is false by default. Enabling it exposes the old unauthenticated `/api/service-requests` routes and is not appropriate for production.

### Production media policy

`CLOUDINARY_MODE=real` makes Multer keep images in memory only until Cloudinary accepts them. Profile photos use public Cloudinary delivery URLs with upload-time size/quality optimization. Face-match selfies, signatures, onboarding videos, and specialization videos use Cloudinary's `authenticated` delivery type; admin/detail APIs issue expiring download URLs and the database stores only Cloudinary public IDs.

The API secret stays server-side. Worker clients receive a short-lived signed multipart form and upload video bytes directly to Cloudinary, keeping large bodies away from the small Render process.

Existing `/uploads/...` records must be migrated to object storage before the first Render deploy or those old files will disappear on restart/deploy.

## HTTP contract

Success responses use `{ "success": true, "message": "...", ... }`. Errors use `{ "success": false, "message": "..." }`.

Protected routes expect `Authorization: Bearer <jwt>`. Customer tokens contain `type: "user"`; worker tokens are worker-only; admin tokens use a separate signing secret. Do not interchange them.

Status conventions: `400` invalid/rejected operation, `401` invalid session, `403` forbidden, `404` missing resource, `409` state/concurrency conflict, `422` invalid input, `429` throttled, `500` unexpected failure.

### Public and authentication routes

| Prefix | Routes |
| --- | --- |
| `/` | Service identity |
| `/health` | `GET /live`, `GET /ready` |
| `/api/services` | Public service catalog and prices |
| `/api/places` | `GET /cities`, `GET /suggest` |
| `/api/auth` | Worker `POST /send-otp`, `/resend-otp`, `/verify-otp` |
| `/api/user/auth` | Customer OTP routes; authenticated `POST /logout` |
| `/api/public/trial-feedback` | Signed-token form and submission |
| `/api/partner/assessment` | Signed-token assessment form, feedback, and no-show routes |

OTP is unique per `(phone, purpose)`. Verification atomically consumes one valid code, uses secure random codes outside mock mode, and locks after the configured attempt cap.

### Customer routes

All routes below require a customer JWT.

| Prefix | Routes |
| --- | --- |
| `/api/user/profile` | `GET /`, `PUT /` |
| `/api/user/addresses` | list, add, delete, select |
| `/api/user/service-requests` | create/list/active/detail, cancel, retry, payment initiate/confirm |
| `/api/user/trials` | offer/create/list/active/detail, cancel, retry, payment, feedback |
| `/api/user/wallet` | Balance and recent ledger |
| `/api/user/coupons` | List and validate |
| `/api/user/referral` | Referral code and terms |

Normal booking flow:

```text
searching → in_progress(en_route → working) → pending_rating → completed
     └──────────────────────────────→ cancelled
searching → expired → retry (new attempt, same id)
payment: not_due → due → processing → paid | failed
```

The customer UI should render `request.stage`, not derive presentation state from `status`. The server supplies `canRetry`, `canCancel`, `secondsRemaining`, and `payment.payable`.

Trial flow:

```text
assigned → accepted → in_progress → completed
    └────→ declined | expired → optional retry
completed + payment + feedback → reward credit and onboarding decision path
```

### Worker routes

All routes below require a worker JWT.

| Prefix | Routes |
| --- | --- |
| `/api/onboarding` | Personal/location/Aadhaar/face/work/references/consent, submit, status |
| `/api/profile` | Profile, catalog, expertise, specialization-video flow (`POST /expertise/video/upload-signature`, then `/submit`) |
| `/api/worker/onboarding/video` | Tasks, signed upload (`POST /upload-signature`), confirmation, status |
| `/api/jobs` | Availability, offers, own jobs, accept/decline, location, start, complete, rate |
| `/api/earnings` | `GET /summary?period=week|month` |
| `/api/worker/trial` | Status, accept/decline, location, start, complete |
| `/api/worker/assessment` | Intro, slots, book/cancel/check-in, status, certificate, acknowledge |

Job action flags returned by the server are authoritative: `shouldSendLocation`, `canStart`, `canComplete`, and `canRate`. Accepted-job GPS updates are throttled and only accepted while en route. Starting work ends live location sharing.

Worker onboarding lifecycle:

```text
in_progress → submitted → under_review
  non-electrical → pending_trial → trial_* → approved | rejected
  electrical     → pending_assessment → assessment_* → approved | rejected
```

### Admin routes

`POST /api/admin/login` is public and rate-limited. Every other `/api/admin/*` route requires an admin JWT. The routes cover worker/video/specialization review, trial queue and decisions, partner and slot management, assessment review/feedback/decisions, payment recording, and manual job runs. `src/routes/adminRoutes.js` is the exact path inventory.

### Direct Cloudinary video upload

Both worker video flows use the same contract:

1. Call the relevant `upload-signature` endpoint with metadata such as `fileType` and `fileSize`.
2. Build browser/mobile `FormData`; append the binary under `file`, then append every key/value from `data.upload.fields`.
3. `POST` the form to `data.upload.url`. Do not set `Content-Type` manually; the multipart client adds its boundary.
4. Call `confirm-upload` (onboarding) or `submit` (specialization) with the returned `assetId`.

The old `presigned-url`, raw `PUT`, and `s3Key` contract has been removed. Update worker app builds before deploying this backend.

## Realtime contract

Connect Socket.IO to the same origin with `auth: { token }`. Clients must reconnect with exponential backoff and retain REST polling as fallback.

Workers receive `jobs:open`, `job:offer`, `job:taken`, and `job:expired`; they can send `job:accept`, `job:decline`, `job:location`, and `presence:update` with acknowledgements.

Customers receive:

- Normal work: `requests:active`, `request:searching`, `request:accepted`, `request:location`, arrival-stage events, `request:started`, `request:work_done`, `request:completed`, `request:paid`, `request:cancelled`, `request:expired`.
- Trials: `trials:active`, `trial:searching`, `trial:accepted`, `trial:location`, arrival-stage events, `trial:started`, `trial:feedback_requested`, `trial:paid`, `trial:no_workers`, `trial:cancelled`.

High-frequency location events are compact deltas. State-transition events contain the same serialized object returned by REST.

The emitter and rate limiter are process-local. Before horizontal scaling, add a Socket.IO Redis adapter, a shared rate-limit store, and distributed leases or a separate worker process for sweepers. Render can route reconnecting WebSockets to any instance.

## Database design and indexes

Primary collections are users, workers, service requests, trial jobs, worker assessments, assessment slots, partner shops, OTPs, onboarding/specialization videos, status transitions, saved addresses, and user/worker wallet ledgers.

Important consistency rules:

- Unique phone keys identify users/workers; OTP is unique by phone and audience.
- Payment/reward ledger indexes make credits idempotent.
- Service-request acceptance is first-writer-wins. Worker assignment is also atomic, preventing one worker from accepting two jobs concurrently.
- Assessment capacity is decremented atomically; active addresses and partner slot instants are uniquely constrained.
- Customer/worker histories are capped at 50 rows; admin lists are paginated or bounded.
- Worker lifetime earnings are summed in MongoDB rather than loaded into Node.

Hot indexes cover customer/status/history reads, worker offer inbox and history, earnings, dispatch deadlines, trial offer/feedback sweeps, assessment review/no-show/payment sweeps, video reconciliation, and geo searches.

Production disables Mongoose auto-indexing. Run this once against each production database after schema changes:

```bash
npm run db:indexes
```

The command is additive and does not drop old indexes. Verify query plans in MongoDB Atlas. The configured database could not be reached from the development sandbox during this audit, so production index creation and `explain("executionStats")` remain deployment checks.

## Performance and capacity

Implemented safeguards:

- MongoDB pool capped at 20 connections with bounded timeouts and retry settings.
- Compound indexes match frequent polling, geo dispatch, histories, and sweep deadlines.
- Read-only lists use lean objects; lifetime earnings use aggregation.
- Request bodies are limited; API/auth/admin rate limits protect the process.
- Responses include `Server-Timing`; requests slower than `SLOW_REQUEST_MS` log as `[slow-request]`.
- Socket location updates avoid full serialization except on stage changes.
- Shutdown stops sweepers, drains HTTP, and disconnects MongoDB.
- Production media bypasses local persistent storage.

“10,000 users” means database population, not concurrency. Capacity depends on request mix, WebSocket count, GPS cadence, MongoDB tier/region, provider latency, and payload size. Load-test login, profile cold start, booking and geo dispatch, worker polling, GPS updates, active-request reads, and reconnect storms. Track p50/p95/p99 latency, errors, event-loop delay, memory, query execution, pool checkout, and provider latency.

Suggested paid-launch go/no-go targets:

- Health/readiness success above 99.9% during the run.
- Error rate below 1%, excluding intentional `4xx` responses.
- p95 reads below 300 ms and p95 mutations below 500 ms when external providers are excluded.
- No collection scans on hot queries or sustained pool saturation.
- Stable heap and event-loop delay under intended WebSocket/GPS load.

## Render deployment

`render.yaml` defines the free beta service, `npm ci`, `npm start`, and `/health/ready`.

1. Create/sync the Blueprint and place the service near MongoDB.
2. Set every secret marked `sync: false`; never put values in `render.yaml`.
3. Set `CLOUDINARY_MODE=real` and the three Cloudinary credentials, then run `npm run cloudinary:check` locally before deploy.
4. Set `CORS_ORIGINS` to the exact Vercel production URL (plus any other trusted app origins), for example `https://kaaryo-admin.vercel.app`.
5. Run `npm run db:indexes` from a trusted environment with database access.
6. Seed the admin intentionally with `npm run seed:admin`, then remove seed credentials where possible.
7. Run the end-to-end clients under `scripts/`, monitor slow logs, and verify socket reconnects.

The free tier cold-starts and can drop sockets during deploys/restarts. Upgrade before promising always-on production latency.

## Vercel admin deployment

The admin is a static build; the API remains on Render. In Vercel, import this repository, leave the project root at the repository root, and add `ADMIN_API_BASE_URL=https://your-api.onrender.com` to Production and Preview environments. `vercel.json` runs the build and publishes `admin-dist`.

CLI equivalent:

```bash
npm i -g vercel
vercel
vercel env add ADMIN_API_BASE_URL production
vercel env add ADMIN_API_BASE_URL preview
vercel --prod
```

After Vercel gives you the final URL, put that exact origin in Render's `CORS_ORIGINS` and redeploy the API. The admin token is kept in `sessionStorage`, expires after `ADMIN_JWT_EXPIRES_IN` (default `8h`), and disappears when that browser tab session closes.

## Testing and operations

```bash
npm test
npm audit
npm run cloudinary:check # requires CLOUDINARY_MODE=real and credentials
npm run test:trial
npm run test:tracking
npm run test:media
npm run check
ADMIN_API_BASE_URL=http://localhost:5000 npm run build:admin
ADMIN_API_BASE_URL=http://localhost:5000 npm run preview:admin
npm run db:indexes       # changes database indexes
npm run seed:admin       # changes database state
npm run seed:shops       # changes database state
npm run worker-client    # simulate a worker in a separate terminal
npm run user-client      # simulate a customer in a separate terminal
```

- `/health/live` proves the process is running; `/health/ready` requires MongoDB.
- Search logs for `[slow-request]`, sweeper errors, payment credit retries, and provider failures.
- Alert on readiness failures, restart loops, pool saturation, payment reconciliation gaps, and stale review queues.
- Payment capture and ledger credit are separate idempotent steps; reconciliation should retry paid-but-uncredited records.
- Do not run multiple app instances until sockets, rate limits, and sweepers use shared coordination.

## Remaining launch work

These need vendor accounts, production data, or client behavior:

- Implement and certify real SMS, payment, Aadhaar/face-match, WhatsApp, and payout adapters.
- Migrate existing local `/uploads` media and rewrite those database references. Any pre-migration S3 records also need a one-time Cloudinary asset import and `assetId` rewrite; this repository no longer reads S3 keys.
- Run `db:indexes` and inspect Atlas query plans against production-like data.
- Perform load tests with realistic geography and GPS/WebSocket cadence.
- Add backups, monitoring/alerting, payment reconciliation, and secret rotation.
- Upgrade off Render free tier for a real public launch.

## Known product boundaries

There is no customer rating system, wallet redemption/withdrawal flow, cancellation fee, production push adapter, or distributed multi-instance coordination. Pricing and several provider adapters remain configuration/mock driven. Treat these as explicit product gaps.
