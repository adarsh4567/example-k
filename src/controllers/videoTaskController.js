const Worker = require('../models/Worker');
const WorkerOnboardingVideo = require('../models/WorkerOnboardingVideo');
const s3 = require('../services/s3Service');
const { ok, fail } = require('../utils/response');

// Static instructions shown on the RN "Task Instructions" screen. Kept server-side
// so copy can change without shipping a new app build.
const TASKS = [
  {
    taskNumber: 1,
    title: 'Task 1 — Mopping a floor',
    description:
      'Record a video of yourself mopping a floor. Show the full process from start to finish. Use any mop or cloth available at home. Video should be between 1 and 3 minutes.',
  },
  {
    taskNumber: 2,
    title: 'Task 2 — Cleaning a bathroom sink',
    description:
      'Record a video of yourself cleaning a bathroom sink. Show how you apply the cleaner, scrub, and rinse. Video should be between 1 and 3 minutes.',
  },
];

const TIPS = [
  'Record in good lighting.',
  'Make sure your face and hands are visible.',
  'Speak naturally if you want to explain what you are doing.',
  'Do not send a video recorded by someone else.',
];

// Client-side rules the app should enforce; echoed here so both sides agree.
const LIMITS = {
  maxBytes: s3.MAX_BYTES,
  minDurationSeconds: 30,
  maxDurationSeconds: 180,
  allowedContentTypes: s3.ALLOWED_CONTENT_TYPES,
};

// Serialise one video doc for API responses (never leaks presigned URLs from DB).
function videoView(doc) {
  if (!doc) return { status: 'not-started' };
  return {
    taskNumber: doc.taskNumber,
    status: doc.status,
    attempt: doc.attempt,
    fileSizeBytes: doc.fileSizeBytes || null,
    durationSeconds: doc.durationSeconds || null,
    uploadedAt: doc.uploadedAt || null,
    reviewerScore: doc.reviewerScore || null,
    rejectionReason: doc.rejectionReason || null,
  };
}

// GET /api/worker/onboarding/video/tasks
async function getTasks(req, res, next) {
  try {
    const stage = (req.worker.videoTask && req.worker.videoTask.stage) || 'not_started';
    return ok(res, { tasks: TASKS, tips: TIPS, limits: LIMITS, stage }, 'Video tasks fetched');
  } catch (err) {
    next(err);
  }
}

// POST /api/worker/onboarding/video/presigned-url
// body: { taskNumber, fileName, fileType, fileSize }
async function getPresignedUrl(req, res, next) {
  try {
    const worker = req.worker;
    const taskNumber = Number(req.body.taskNumber);
    const { fileType } = req.body;
    const fileSize = Number(req.body.fileSize);

    if (![1, 2].includes(taskNumber)) return fail(res, 'taskNumber must be 1 or 2', 422);
    if (!s3.isAllowedContentType(fileType)) {
      return fail(res, 'Only video/mp4 and video/quicktime are allowed', 422);
    }
    if (!Number.isFinite(fileSize) || fileSize <= 0) return fail(res, 'A valid fileSize is required', 422);
    if (fileSize > s3.MAX_BYTES) {
      return fail(res, `Video exceeds the ${Math.round(s3.MAX_BYTES / (1024 * 1024))}MB limit`, 413);
    }

    const vt = worker.videoTask || {};
    let stage = vt.stage || 'not_started';
    let attempt = vt.attempt || 1;

    // A 60-day-old permanent rejection is allowed to start over.
    if (stage === 'permanently_rejected') {
      if (vt.reapplyAllowedAt && vt.reapplyAllowedAt <= new Date()) {
        stage = 'not_started';
        attempt = 1;
      } else {
        return fail(
          res,
          'Your application was rejected and cannot be resubmitted at this time.',
          403,
          { reapplyAllowedAt: vt.reapplyAllowedAt || null }
        );
      }
    }
    if (stage === 'approved') return fail(res, 'Your videos are already approved', 409);
    if (stage === 'review_pending') {
      return fail(res, 'Your videos are submitted and awaiting review', 409);
    }

    // Transition into an active upload session, bumping the attempt on a re-upload.
    if (stage === 'not_started') {
      attempt = 1;
    } else if (stage === 'rejected') {
      attempt = Math.min(2, (attempt || 1) + 1); // second and final attempt
    } // 'in_progress' → keep the current attempt (e.g. expired URL / reselect)

    const s3Key = s3.buildVideoKey(worker._id, taskNumber, fileType);
    const { url, expiresIn } = await s3.getPresignedPutUrl({ key: s3Key, contentType: fileType });

    // One live record per (worker, task): upsert and reset any prior review state.
    await WorkerOnboardingVideo.findOneAndUpdate(
      { worker: worker._id, taskNumber },
      {
        worker: worker._id,
        taskNumber,
        s3Key,
        fileType,
        fileSizeBytes: fileSize,
        status: 'pending',
        attempt,
        uploadedAt: null,
        reviewer: null,
        reviewerScore: null,
        reviewerNotes: null,
        rejectionReason: null,
        reviewedAt: null,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    worker.videoTask.stage = 'in_progress';
    worker.videoTask.attempt = attempt;
    await worker.save();

    return ok(
      res,
      {
        presignedUrl: url,
        s3Key,
        expiresIn,
        // The client must PUT with exactly this header for the signature to match.
        requiredHeaders: { 'Content-Type': fileType },
      },
      'Presigned URL generated'
    );
  } catch (err) {
    next(err);
  }
}

// POST /api/worker/onboarding/video/confirm-upload
// body: { taskNumber, s3Key, durationSeconds? }
async function confirmUpload(req, res, next) {
  try {
    const worker = req.worker;
    const taskNumber = Number(req.body.taskNumber);
    const { s3Key } = req.body;
    const durationSeconds = req.body.durationSeconds != null ? Number(req.body.durationSeconds) : null;

    if (![1, 2].includes(taskNumber)) return fail(res, 'taskNumber must be 1 or 2', 422);
    if (!s3Key) return fail(res, 's3Key is required', 422);

    // Bind the key to this worker: it must be the one we issued and live under their path.
    const expectedPrefix = `workers/${worker._id}/`;
    if (!String(s3Key).startsWith(expectedPrefix)) {
      return fail(res, 'This upload does not belong to you', 403);
    }

    const doc = await WorkerOnboardingVideo.findOne({ worker: worker._id, taskNumber });
    if (!doc || doc.s3Key !== s3Key) {
      return fail(res, 'No matching pending upload found for this task', 404);
    }

    // Verify the file actually landed on S3.
    const head = await s3.headObject(s3Key);
    if (!head.exists) {
      return fail(res, 'File not found on storage. Please retry the upload.', 409);
    }

    // Server-side size guard (defends against a bypassed client / oversized PUT).
    if (head.contentLength != null && head.contentLength > s3.MAX_BYTES) {
      await s3.deleteObject(s3Key).catch(() => {});
      return fail(res, 'Uploaded file exceeds the size limit and was discarded', 413);
    }

    doc.status = 'uploaded';
    doc.uploadedAt = new Date();
    if (durationSeconds != null && Number.isFinite(durationSeconds)) doc.durationSeconds = durationSeconds;
    if (head.contentLength != null) doc.fileSizeBytes = head.contentLength;
    await doc.save();

    // Are both task videos now uploaded?
    const docs = await WorkerOnboardingVideo.find({ worker: worker._id });
    const byTask = { 1: null, 2: null };
    docs.forEach((d) => { byTask[d.taskNumber] = d; });
    const bothUploaded =
      byTask[1] && byTask[2] &&
      ['uploaded', 'under_review'].includes(byTask[1].status) &&
      ['uploaded', 'under_review'].includes(byTask[2].status);

    if (bothUploaded) {
      worker.videoTask.stage = 'review_pending';
      worker.videoTask.submittedAt = new Date();

      // Duplicate-video heuristic: identical size AND duration for both tasks.
      const a = byTask[1];
      const b = byTask[2];
      worker.videoTask.duplicateSuspected = !!(
        a.fileSizeBytes && b.fileSizeBytes && a.durationSeconds && b.durationSeconds &&
        a.fileSizeBytes === b.fileSizeBytes && a.durationSeconds === b.durationSeconds
      );

      worker.reviewLog.push({
        action: 'video_submitted',
        by: 'system',
        message: vt.duplicateSuspected ? 'Possible duplicate video submission' : '',
      });
      await worker.save();
    }

    return ok(
      res,
      {
        task: videoView(doc),
        bothUploaded: !!bothUploaded,
        stage: worker.videoTask.stage,
      },
      'Upload confirmed'
    );
  } catch (err) {
    next(err);
  }
}

// GET /api/worker/onboarding/video/status
async function getStatus(req, res, next) {
  try {
    const worker = req.worker;
    const docs = await WorkerOnboardingVideo.find({ worker: worker._id });
    const byTask = {};
    docs.forEach((d) => { byTask[d.taskNumber] = d; });

    // Attach a short-lived preview URL for already-uploaded videos so the app can
    // restore a thumbnail/preview when resuming an interrupted session.
    async function taskPayload(n) {
      const d = byTask[n];
      const view = videoView(d);
      if (d && ['uploaded', 'under_review', 'approved', 'rejected'].includes(d.status)) {
        try { view.previewUrl = await s3.getPresignedGetUrl(d.s3Key); } catch (_) { /* non-fatal */ }
      }
      return view;
    }

    const [task1, task2] = await Promise.all([taskPayload(1), taskPayload(2)]);
    const vt = worker.videoTask || {};
    return ok(
      res,
      {
        stage: vt.stage || 'not_started',
        attempt: vt.attempt || 1,
        submittedAt: vt.submittedAt || null,
        reapplyAllowedAt: vt.reapplyAllowedAt || null,
        task1,
        task2,
      },
      'Video task status'
    );
  } catch (err) {
    next(err);
  }
}

module.exports = { getTasks, getPresignedUrl, confirmUpload, getStatus, TASKS, TIPS, LIMITS };
