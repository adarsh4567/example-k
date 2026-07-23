const TrialJob = require('../models/TrialJob');
const { ok, fail } = require('../utils/response');
const { transitionWorker } = require('../services/workerStatusService');
const { trialWorkerView } = require('../utils/trialPayload');
const { FEEDBACK_SLA_MINUTES } = require('../config/trialConfig');
const trialJobs = require('../services/trialJobsService');

// Statuses that count as the worker's "current" trial job (still in flight).
const LIVE_STATUSES = ['assigned', 'accepted', 'in_progress', 'completed'];

// The trial job to act on / show. A worker only ever has one live at a time.
async function findLatestTrialJob(workerId) {
  return TrialJob.findOne({ worker: workerId }).sort({ createdAt: -1 });
}

async function loadOwnedJob(req, res) {
  const job = await TrialJob.findById(req.params.id);
  if (!job) {
    fail(res, 'Trial job not found', 404);
    return null;
  }
  if (String(job.worker) !== String(req.worker._id)) {
    fail(res, 'This trial job is not assigned to you', 403);
    return null;
  }
  return job;
}

// GET /api/worker/trial/status
// Cheap fallback poll for the waiting/submitted screens. Returns the worker's
// current trial status plus the latest trial job (null if none yet).
async function getStatus(req, res, next) {
  try {
    const job = await findLatestTrialJob(req.worker._id);
    return ok(
      res,
      {
        status: req.worker.status,
        currentTrialJob: job ? trialWorkerView(job) : null,
      },
      'Trial status'
    );
  } catch (err) {
    next(err);
  }
}

// POST /api/worker/trial/:id/accept
async function acceptTrial(req, res, next) {
  try {
    const job = await loadOwnedJob(req, res);
    if (!job) return;
    if (job.status !== 'assigned') {
      return fail(res, `This offer can no longer be accepted (status: ${job.status})`, 409);
    }

    // Expired before the sweeper caught it: expire now and bounce to the queue.
    if (job.offerExpiresAt && job.offerExpiresAt.getTime() <= Date.now()) {
      job.status = 'expired';
      job.declinedReason = 'timeout';
      job.declinedAt = new Date();
      await job.save();
      await transitionWorker(req.worker, 'pending_trial', {
        reason: 'Trial offer expired before acceptance',
        trialJob: job._id,
      });
      return fail(res, 'This trial offer has expired', 409);
    }

    job.status = 'accepted';
    job.acceptedAt = new Date();
    await job.save();

    await transitionWorker(req.worker, 'trial_accepted', { reason: 'Worker accepted trial job', trialJob: job._id });

    return ok(res, { trialJob: trialWorkerView(job) }, 'Trial job accepted');
  } catch (err) {
    next(err);
  }
}

// POST /api/worker/trial/:id/decline
async function declineTrial(req, res, next) {
  try {
    const job = await loadOwnedJob(req, res);
    if (!job) return;
    if (job.status !== 'assigned') {
      return fail(res, `Only an outstanding offer can be declined (status: ${job.status})`, 409);
    }

    job.status = 'declined';
    job.declinedReason = 'worker_declined';
    job.declinedAt = new Date();
    await job.save();

    // Back into the queue — but log it as a seriousness signal for ops (a
    // decline on a trial job is itself meaningful; repeated declines are visible
    // in the WorkerStatusTransition audit).
    await transitionWorker(req.worker, 'pending_trial', {
      reason: 'Worker DECLINED trial job (ops signal)',
      trialJob: job._id,
    });

    return ok(res, { trialJob: trialWorkerView(job) }, 'Trial job declined — back in the queue');
  } catch (err) {
    next(err);
  }
}

// POST /api/worker/trial/:id/start
async function startTrial(req, res, next) {
  try {
    const job = await loadOwnedJob(req, res);
    if (!job) return;
    if (job.status !== 'accepted') {
      return fail(res, `You can only start an accepted trial job (status: ${job.status})`, 409);
    }

    job.status = 'in_progress';
    job.startedAt = new Date();
    await job.save();

    await transitionWorker(req.worker, 'trial_in_progress', { reason: 'Worker started trial job', trialJob: job._id });

    return ok(res, { trialJob: trialWorkerView(job) }, 'Trial job started');
  } catch (err) {
    next(err);
  }
}

// POST /api/worker/trial/:id/complete   { photos?: string[], notes?: string }
async function completeTrial(req, res, next) {
  try {
    const job = await loadOwnedJob(req, res);
    if (!job) return;
    if (job.status !== 'in_progress') {
      return fail(res, `Only an in-progress trial job can be completed (status: ${job.status})`, 409);
    }

    const { photos, notes } = req.body || {};
    const now = new Date();

    job.status = 'completed';
    job.completedAt = now;
    job.checkout = {
      photos: Array.isArray(photos) ? photos.map(String) : [],
      notes: typeof notes === 'string' ? notes : '',
    };
    // Open the feedback window: decision is null until the customer submits.
    job.feedback.decision = null;
    job.feedback.slaDeadlineAt = new Date(now.getTime() + FEEDBACK_SLA_MINUTES * 60 * 1000);
    await job.save();

    await transitionWorker(req.worker, 'trial_completed', { reason: 'Worker completed trial job', trialJob: job._id });

    // Fire the customer feedback request (SMS link — mock/console in dev).
    await trialJobs.sendFeedbackRequest(job).catch((e) => {
      console.error('[trial] failed to send feedback request:', e.message);
    });

    return ok(
      res,
      { trialJob: trialWorkerView(job) },
      'Trial job completed — the customer has been asked for feedback'
    );
  } catch (err) {
    next(err);
  }
}

module.exports = { getStatus, acceptTrial, declineTrial, startTrial, completeTrial, LIVE_STATUSES };
