/**
 * Background maintenance for the practical-video-task feature. Opt-in via
 * VIDEO_JOBS_ENABLED=true (needs working S3 access, so it stays off locally).
 *
 * 1. Reconciliation — an upload can succeed on S3 while the confirm-upload API
 *    call is lost (network drop). This finds "pending" records whose object is
 *    actually present and promotes them to "uploaded".
 * 2. Reviewer SLA alert — flags submissions sitting in the queue > 48h so the
 *    team lead can be pinged (console + optional Slack webhook).
 */

const Worker = require('../models/Worker');
const WorkerOnboardingVideo = require('../models/WorkerOnboardingVideo');
const s3 = require('./s3Service');

const SWEEP_INTERVAL_MS = (Number(process.env.VIDEO_JOBS_SWEEP_MINUTES) || 10) * 60 * 1000;
const RECONCILE_MIN_AGE_MS = 5 * 60 * 1000;        // only touch pending records older than 5 min
const STALE_REVIEW_MS = 48 * 60 * 60 * 1000;       // 48h SLA

async function reconcilePendingUploads() {
  const cutoff = new Date(Date.now() - RECONCILE_MIN_AGE_MS);
  const pending = await WorkerOnboardingVideo.find({ status: 'pending', createdAt: { $lte: cutoff } });

  const affectedWorkers = new Set();
  for (const doc of pending) {
    try {
      const head = await s3.headObject(doc.s3Key);
      if (head.exists) {
        doc.status = 'uploaded';
        doc.uploadedAt = doc.uploadedAt || new Date();
        if (head.contentLength != null) doc.fileSizeBytes = head.contentLength;
        await doc.save();
        affectedWorkers.add(String(doc.worker));
        console.log(`🩹 [video-reconcile] promoted orphaned upload ${doc.s3Key}`);
      }
    } catch (err) {
      console.error(`[video-reconcile] headObject failed for ${doc.s3Key}: ${err.message}`);
    }
  }

  // Re-evaluate "both uploaded" for any worker we just healed.
  for (const workerId of affectedWorkers) {
    const docs = await WorkerOnboardingVideo.find({ worker: workerId });
    const t1 = docs.find((d) => d.taskNumber === 1);
    const t2 = docs.find((d) => d.taskNumber === 2);
    const both = t1 && t2 &&
      ['uploaded', 'under_review'].includes(t1.status) &&
      ['uploaded', 'under_review'].includes(t2.status);
    if (!both) continue;
    const worker = await Worker.findById(workerId);
    if (worker && worker.videoTask && ['in_progress', 'not_started'].includes(worker.videoTask.stage)) {
      worker.videoTask.stage = 'review_pending';
      worker.videoTask.submittedAt = worker.videoTask.submittedAt || new Date();
      await worker.save();
    }
  }
}

async function alertStaleReviews() {
  const cutoff = new Date(Date.now() - STALE_REVIEW_MS);
  const stale = await Worker.find({
    'videoTask.stage': { $in: ['review_pending', 'under_review'] },
    'videoTask.submittedAt': { $lte: cutoff },
    'videoTask.staleAlerted': { $ne: true },
  }).select('phone fullName videoTask');

  for (const worker of stale) {
    const msg = `⏰ Video review overdue (>48h): ${worker.fullName || worker.phone} (${worker._id})`;
    console.warn(msg);
    const hook = process.env.SLACK_WEBHOOK_URL;
    if (hook && typeof fetch === 'function') {
      try {
        await fetch(hook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: msg }),
        });
      } catch (err) {
        console.error(`[video-sla] Slack webhook failed: ${err.message}`);
      }
    }
    worker.videoTask.staleAlerted = true;
    await worker.save();
  }
}

async function sweep() {
  try {
    await reconcilePendingUploads();
    await alertStaleReviews();
  } catch (err) {
    console.error(`[video-jobs] sweep error: ${err.message}`);
  }
}

function startSweeper() {
  if (process.env.VIDEO_JOBS_ENABLED !== 'true') {
    console.log('🎬 Video maintenance jobs disabled (set VIDEO_JOBS_ENABLED=true to enable)');
    return;
  }
  console.log(`🎬 Video maintenance jobs running every ${SWEEP_INTERVAL_MS / 60000} min`);
  setInterval(sweep, SWEEP_INTERVAL_MS).unref();
}

module.exports = { startSweeper, reconcilePendingUploads, alertStaleReviews };
