const Worker = require('../models/Worker');
const WorkerOnboardingVideo = require('../models/WorkerOnboardingVideo');
const s3 = require('../services/s3Service');
const { notifyWorker } = require('../services/notificationService');
const { ok, fail } = require('../utils/response');

const REJECTION_REASON_LABELS = {
  poor_technique: 'Poor technique',
  video_quality_too_bad: 'Video quality too poor to assess',
  does_not_show_task: 'Video does not show the required task',
  suspicious_staged: 'Video looks pre-recorded or staged',
  other: 'Other',
};

const RE_APPLY_BLOCK_DAYS = 60;

// GET /api/admin/video-review/queue?page=1&limit=20
// Workers awaiting a practical-video decision, oldest submission first.
async function queue(req, res, next) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Number(req.query.limit) || 20);
    const query = { 'videoTask.stage': { $in: ['review_pending', 'under_review'] } };

    const [total, workers] = await Promise.all([
      Worker.countDocuments(query),
      Worker.find(query)
        .select('phone fullName location.city videoTask createdAt')
        .sort({ 'videoTask.submittedAt': 1 }) // oldest first
        .skip((page - 1) * limit)
        .limit(limit),
    ]);

    return ok(res, { total, page, limit, workers }, 'Video review queue');
  } catch (err) {
    next(err);
  }
}

// GET /api/admin/video-review/:workerId
// Worker header info + both task videos with short-lived presigned streaming URLs.
async function getWorkerVideos(req, res, next) {
  try {
    const worker = await Worker.findById(req.params.workerId).select(
      'phone fullName location videoTask reviewLog'
    );
    if (!worker) return fail(res, 'Worker not found', 404);

    const docs = await WorkerOnboardingVideo.find({ worker: worker._id }).sort({ taskNumber: 1 });

    const videos = await Promise.all(
      docs.map(async (d) => {
        let playbackUrl = null;
        try {
          playbackUrl = await s3.getPresignedGetUrl(d.s3Key);
        } catch (_) {
          /* non-fatal — the URL just won't render */
        }
        return {
          taskNumber: d.taskNumber,
          status: d.status,
          attempt: d.attempt,
          fileType: d.fileType,
          fileSizeBytes: d.fileSizeBytes || null,
          durationSeconds: d.durationSeconds || null,
          uploadedAt: d.uploadedAt || null,
          reviewerScore: d.reviewerScore || null,
          rejectionReason: d.rejectionReason || null,
          playbackUrl,
          playbackExpiresIn: s3.GET_URL_TTL,
        };
      })
    );

    return ok(
      res,
      {
        worker: {
          id: worker._id,
          fullName: worker.fullName,
          phone: worker.phone,
          city: worker.location && worker.location.city,
          videoTask: worker.videoTask,
        },
        videos,
        rejectionReasons: Object.entries(REJECTION_REASON_LABELS).map(([value, label]) => ({ value, label })),
      },
      'Worker videos'
    );
  } catch (err) {
    next(err);
  }
}

// POST /api/admin/video-review/:workerId/decision
// body: { decision: 'approve'|'reject', task1Score?, task2Score?, notes?, rejectionReason? }
async function decide(req, res, next) {
  try {
    const { decision, task1Score, task2Score, notes, rejectionReason } = req.body;
    if (!['approve', 'reject'].includes(decision)) {
      return fail(res, "decision must be 'approve' or 'reject'", 422);
    }

    const worker = await Worker.findById(req.params.workerId);
    if (!worker) return fail(res, 'Worker not found', 404);

    const stage = worker.videoTask && worker.videoTask.stage;
    if (!['review_pending', 'under_review'].includes(stage)) {
      return fail(res, `Videos are not awaiting review (current stage: ${stage || 'not_started'})`, 409);
    }

    const docs = await WorkerOnboardingVideo.find({ worker: worker._id });
    if (docs.length < 2) return fail(res, 'Both task videos must be uploaded before reviewing', 409);

    const scoreFor = { 1: Number(task1Score), 2: Number(task2Score) };
    const now = new Date();

    if (decision === 'approve') {
      for (const d of docs) {
        d.status = 'approved';
        d.reviewer = req.admin._id;
        if (Number.isFinite(scoreFor[d.taskNumber]) && scoreFor[d.taskNumber] >= 1 && scoreFor[d.taskNumber] <= 5) {
          d.reviewerScore = scoreFor[d.taskNumber];
        }
        d.reviewerNotes = notes || null;
        d.rejectionReason = null;
        d.reviewedAt = now;
        await d.save();
      }

      worker.videoTask.stage = 'approved';
      worker.videoTask.reviewedAt = now;
      worker.reviewLog.push({ action: 'video_approved', by: req.admin.email, message: notes || '' });
      await worker.save();

      await notifyWorker(worker, {
        title: 'Great news! Your task videos have been approved',
        message: 'Please continue your Kaaryo application.',
      });

      return ok(res, { stage: worker.videoTask.stage }, 'Videos approved');
    }

    // ── Reject ──
    if (!rejectionReason || !REJECTION_REASON_LABELS[rejectionReason]) {
      return fail(res, 'A valid rejectionReason is required to reject', 422);
    }

    for (const d of docs) {
      d.status = 'rejected';
      d.reviewer = req.admin._id;
      if (Number.isFinite(scoreFor[d.taskNumber]) && scoreFor[d.taskNumber] >= 1 && scoreFor[d.taskNumber] <= 5) {
        d.reviewerScore = scoreFor[d.taskNumber];
      }
      d.reviewerNotes = notes || null;
      d.rejectionReason = rejectionReason;
      d.reviewedAt = now;
      await d.save();
    }

    const label = REJECTION_REASON_LABELS[rejectionReason];
    const priorAttempt = worker.videoTask.attempt || 1;
    const isPermanent = priorAttempt >= 2; // failed the re-upload → permanent

    worker.videoTask.reviewedAt = now;
    if (isPermanent) {
      worker.videoTask.stage = 'permanently_rejected';
      worker.videoTask.reapplyAllowedAt = new Date(now.getTime() + RE_APPLY_BLOCK_DAYS * 24 * 60 * 60 * 1000);
      worker.status = 'rejected';
      worker.reviewLog.push({
        action: 'video_rejected_permanent',
        by: req.admin.email,
        message: `${label}${notes ? ' — ' + notes : ''}`,
      });
      await worker.save();

      await notifyWorker(worker, {
        title: 'Application update',
        message: `Your task videos were not approved (${label}). Your application cannot be resubmitted for ${RE_APPLY_BLOCK_DAYS} days.`,
      });
    } else {
      worker.videoTask.stage = 'rejected';
      worker.reviewLog.push({
        action: 'video_rejected',
        by: req.admin.email,
        message: `${label}${notes ? ' — ' + notes : ''}`,
      });
      await worker.save();

      await notifyWorker(worker, {
        title: 'Please re-record your task videos',
        message: `Your videos were not approved (${label}). You may re-upload one more time. ${notes || ''}`.trim(),
      });
    }

    return ok(res, { stage: worker.videoTask.stage, permanent: isPermanent }, 'Videos rejected');
  } catch (err) {
    next(err);
  }
}

module.exports = { queue, getWorkerVideos, decide, REJECTION_REASON_LABELS };
