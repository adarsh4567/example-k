# Filter 1 — Practical Video Task (Backend)

Backend implementation of the two-video practical task: worker uploads two videos
**directly to S3 via presigned URLs** (EC2 is never in the upload path), the reviewer
team scores/decides them in the admin panel, and the worker is notified of the result.

Stack note: this repo is **Express + MongoDB (Mongoose)**, so the relational
`worker_onboarding_videos` table from the plan is a Mongoose collection, and the
"onboarding stage" is tracked on the worker in a `videoTask` sub-object.

---

## 1. What was added

| File | Purpose |
|------|---------|
| `src/models/WorkerOnboardingVideo.js` | One doc per `(worker, taskNumber)` — S3 key, size, duration, status, reviewer score/notes/reason. |
| `src/models/Worker.js` | New `videoTask` sub-object (stage machine, attempt, submittedAt, duplicate flag, reapply gate). |
| `src/services/s3Service.js` | Presigned PUT/GET, `headObject`, delete, key builder. `S3_MODE=mock\|real`. Uses the EC2 IAM role — no keys in code. |
| `src/controllers/videoTaskController.js` | Worker endpoints: tasks, presigned-url, confirm-upload, status. |
| `src/routes/videoTaskRoutes.js` | Mounted at `/api/worker/onboarding/video` (worker JWT). |
| `src/controllers/videoReviewController.js` | Admin endpoints: queue, worker videos (with playback URLs), decision. |
| `src/routes/adminRoutes.js` | Added `/video-review/*` routes (admin JWT). |
| `src/services/videoJobsService.js` | Opt-in sweeper: reconcile orphaned uploads + 48h reviewer-SLA alert. |
| `admin.html` | "🎬 Video Review Queue" button → queue → per-worker review modal (HTML5 players, 1–5 scores, notes, approve/reject with mandatory reason). |
| `.env` | S3 / video config block appended (see §5). |

Installed: `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `uuid`.

---

## 2. Worker API (JWT via `Authorization: Bearer <workerToken>`)

Base: `/api/worker/onboarding/video`

### `GET /tasks`
Instructions + tips + limits (so the app doesn't hardcode copy) and current `stage`.
```json
{ "success": true, "tasks": [{ "taskNumber": 1, "title": "...", "description": "..." }],
  "tips": ["..."], "limits": { "maxBytes": 209715200, "minDurationSeconds": 30,
  "maxDurationSeconds": 180, "allowedContentTypes": ["video/mp4","video/quicktime"] },
  "stage": "not_started" }
```

### `POST /presigned-url`
Body: `{ taskNumber: 1|2, fileName, fileType: "video/mp4"|"video/quicktime", fileSize: <bytes> }`
Validates task/type/size, generates the S3 key `workers/{workerId}/onboarding/task{n}/{ts}-{uuid}.{ext}`,
upserts a `pending` record, returns:
```json
{ "success": true, "presignedUrl": "https://...", "s3Key": "workers/.../task1/...mp4",
  "expiresIn": 900, "requiredHeaders": { "Content-Type": "video/mp4" } }
```
**The client must PUT the raw file to `presignedUrl` with exactly that `Content-Type` header** — it's part of the signature.

### `POST /confirm-upload`
Body: `{ taskNumber, s3Key, durationSeconds? }`
Confirms the key belongs to this worker, verifies the object exists via S3 `headObject`
(and enforces the size cap server-side), flips the record to `uploaded`. When **both**
tasks are uploaded it sets the worker stage to `review_pending` and flags a possible
duplicate if both videos share size+duration.
```json
{ "success": true, "task": { "taskNumber": 1, "status": "uploaded" },
  "bothUploaded": true, "stage": "review_pending" }
```

### `GET /status`
Resume support — per-task status + a short-lived `previewUrl` for uploaded videos.
```json
{ "success": true, "stage": "review_pending", "attempt": 1, "submittedAt": "...",
  "task1": { "status": "uploaded", "previewUrl": "https://...", "durationSeconds": 95 },
  "task2": { "status": "uploaded", "previewUrl": "https://..." } }
```

### Client upload sequence (for the frontend team)
1. Validate locally (≤200 MB, 30–180 s, mp4/mov). 2. `POST /presigned-url`.
3. `PUT` the file to `presignedUrl` with the `Content-Type` header (track `onUploadProgress`).
4. `POST /confirm-upload` with the `s3Key` (+ duration). 5. Repeat for the second task.
On a network drop, retry from the **saved** `s3Key`/URI while the URL is unexpired (15 min);
if expired, request a fresh presigned URL and retry. Never re-upload an already-`uploaded` task.

---

## 3. Admin API (JWT via `Authorization: Bearer <adminToken>`)

- `GET /api/admin/video-review/queue?page&limit` — workers in `review_pending`/`under_review`, **oldest first**, with `duplicateSuspected` flag.
- `GET /api/admin/video-review/:workerId` — worker header + both videos, each with a **presigned GET `playbackUrl`** (1 h) for HTML5 playback, plus the list of rejection reasons.
- `POST /api/admin/video-review/:workerId/decision`
  `{ decision: "approve"|"reject", task1Score?, task2Score?, notes?, rejectionReason? }`
  - **approve** → both videos `approved`, `videoTask.stage=approved`, worker notified.
  - **reject** → `rejectionReason` required (`poor_technique` \| `video_quality_too_bad` \| `does_not_show_task` \| `suspicious_staged` \| `other`). First rejection → `stage=rejected` (worker may re-upload once). Second rejection → `permanently_rejected`, `reapplyAllowedAt = now+60d`, application `rejected`. Worker notified either way.

These are already wired into `admin.html` — reviewers just click **🎬 Video Review Queue**.

---

## 4. Stage machine (`worker.videoTask.stage`)

```
not_started → in_progress → review_pending → approved
                                ├─ reject(attempt1) → rejected → (re-upload) in_progress → review_pending
                                └─ reject(attempt2) → permanently_rejected  (reapply blocked 60d)
```
Per-video `status`: `pending → uploaded → (approved|rejected)`.

---

## 5. Env vars (set on EC2 — `.env` already has these with dev defaults)

```
S3_MODE=real                 # 'mock' locally = no AWS calls; 'real' on EC2
AWS_REGION=ap-south-1        # match your bucket's region
S3_BUCKET=example-k-bucket
S3_PUT_URL_TTL_SECONDS=900   # 15 min
S3_GET_URL_TTL_SECONDS=3600  # 1 h (admin playback)
VIDEO_MAX_BYTES=209715200    # 200 MB
VIDEO_JOBS_ENABLED=true      # reconcile + SLA sweeper (needs working S3)
VIDEO_JOBS_SWEEP_MINUTES=10
# SLACK_WEBHOOK_URL=https://hooks.slack.com/...   # optional overdue-review alert
```
**Do not put AWS access keys in `.env`.** The SDK reads the EC2 instance's IAM role
automatically. (Only set `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` if you ever test
`S3_MODE=real` from a laptop without a role.)

---

## 6. What YOU do after syncing to EC2 (credentials/infra part)

### a) IAM role for the EC2 instance
Create a role (or use the instance's existing one) with this least-privilege policy, attach it to the EC2 instance:
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:ListBucket"],
    "Resource": [
      "arn:aws:s3:::example-k-bucket",
      "arn:aws:s3:::example-k-bucket/*"
    ]
  }]
}
```
(`s3:ListBucket` is only needed for the reconciliation sweeper; drop it if you keep `VIDEO_JOBS_ENABLED=false`.)

### b) Bucket settings (bucket already exists)
- **Block all public access: ON** (access is only ever via presigned URLs).
- **Default encryption: ON** (SSE-S3).
- Versioning: off.
- **CORS** (required so the phone can PUT directly to S3):
```json
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["PUT", "GET"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```
Tighten `AllowedOrigins` to your app's origins for production.
- **Lifecycle (optional, from the plan):** expire `workers/` objects after 90 days for rejected workers; transition approved workers' videos to Glacier after 1 year. Simplest start: one rule expiring the prefix after 90 days, refine later.

### c) Flip env + restart
Set `S3_MODE=real` (and the region/bucket) in the EC2 `.env`, then `npm start`
(or restart your pm2/systemd process). Startup log should show the video jobs line
if you enabled them.

---

## 7. Edge cases handled (from the plan)

- **Upload fails mid-way / URL still valid** → client retries the same `s3Key` (server keeps the `pending` record).
- **App closed mid-upload** → `GET /status` restores which tasks are already uploaded.
- **Confirm API lost after S3 success** → `videoJobsService` reconciles orphaned `pending` records via `headObject`.
- **Same video for both tasks** → `duplicateSuspected` flag surfaced in the queue + review modal.
- **Reviewer too slow (>48h)** → SLA alert (console + optional Slack webhook), sent once per worker.
- **Oversized upload bypassing the client** → server rejects on confirm (size from `headObject`) and deletes the object.
- **Cross-worker confirm** → rejected: the `s3Key` must live under `workers/{thisWorkerId}/`.

### Note on the 200 MB server cap
We sign the PUT with the file's `Content-Type` and enforce the size on `confirm-upload`
via `headObject` (oversized objects are deleted). For a hard pre-upload byte ceiling you
can switch the presign to `createPresignedPost` with a `content-length-range` condition —
noted here as a later hardening step; the current approach is the common, simpler pattern.
