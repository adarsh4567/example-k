const Worker = require('../models/Worker');
const TrialJob = require('../models/TrialJob');
const { ok, fail } = require('../utils/response');
const { isValidCategory, isValidSubcategory } = require('../services/serviceCatalog');
const { computeTrialPrice } = require('../services/pricingService');
const { transitionWorker } = require('../services/workerStatusService');
const { notifyWorker } = require('../services/notificationService');
const emitter = require('../realtime/emitter');
const tokenService = require('../services/trialTokenService');
const { trialAdminView } = require('../utils/trialPayload');
const { OFFER_WINDOW_SECONDS } = require('../config/trialConfig');

function validCoord(lat, lng) {
  return (
    typeof lat === 'number' && typeof lng === 'number' &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
  );
}

// GET /api/admin/trial-queue
// Everything ops needs: who is waiting for a trial, what needs a human decision
// (conditional verdicts), and what is still awaiting customer feedback.
async function trialQueue(req, res, next) {
  try {
    const [pendingTrial, awaitingDecision, awaitingFeedback] = await Promise.all([
      // Longest-waiting first (updatedAt = when they entered pending_trial).
      Worker.find({ status: 'pending_trial' })
        .select('phone fullName location.city updatedAt')
        .sort({ updatedAt: 1 })
        .limit(100),
      // Conditional verdicts need the 5-min-callback / admin override.
      TrialJob.find({ status: 'completed', 'feedback.decision': 'conditional' })
        .populate('worker', 'phone fullName status')
        .sort({ completedAt: 1 })
        .limit(100),
      // Completed but customer hasn't submitted feedback yet (informational).
      TrialJob.find({ status: 'completed', 'feedback.decision': null, 'feedback.submittedAt': null })
        .populate('worker', 'phone fullName status')
        .sort({ completedAt: 1 })
        .limit(100),
    ]);

    return ok(
      res,
      {
        pendingTrial,
        awaitingDecision: awaitingDecision.map(trialAdminView),
        awaitingFeedback: awaitingFeedback.map(trialAdminView),
        counts: {
          pendingTrial: pendingTrial.length,
          awaitingDecision: awaitingDecision.length,
          awaitingFeedback: awaitingFeedback.length,
        },
      },
      'Trial queue'
    );
  } catch (err) {
    next(err);
  }
}

// GET /api/admin/trial/nearby-workers?lat=..&lng=..
// Mirrors the real dispatch geo-match, scoped to workers awaiting a trial:
// find `pending_trial` workers whose own travel radius (location.travelRadiusKm,
// set during onboarding) covers the user's point, measured from the worker's
// current location. Nearest first. Workers without a current location aren't
// geo-indexed and so can't be matched — same precondition as live dispatch.
const DEFAULT_TRIAL_RADIUS_KM = Number(process.env.TRIAL_MATCH_DEFAULT_RADIUS_KM || 10);
const TRIAL_MATCH_MAX_RADIUS_KM = Number(process.env.TRIAL_MATCH_MAX_RADIUS_KM || 50);

async function nearbyTrialWorkers(req, res, next) {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!validCoord(lat, lng)) return fail(res, 'Valid numeric lat and lng are required', 422);

    const results = await Worker.aggregate([
      {
        $geoNear: {
          near: { type: 'Point', coordinates: [lng, lat] },
          distanceField: 'distanceMeters',
          maxDistance: TRIAL_MATCH_MAX_RADIUS_KM * 1000, // outer bound for performance
          spherical: true,
          query: { status: 'pending_trial' },
        },
      },
      // Enforce the worker's willingness-to-travel: the user's point must fall
      // within the radius the worker chose (fallback to a default if unset).
      {
        $match: {
          $expr: {
            $lte: [
              '$distanceMeters',
              { $multiply: [{ $ifNull: ['$location.travelRadiusKm', DEFAULT_TRIAL_RADIUS_KM] }, 1000] },
            ],
          },
        },
      },
      { $limit: 50 },
      { $project: { fullName: 1, phone: 1, 'location.city': 1, 'location.travelRadiusKm': 1, distanceMeters: 1 } },
    ]);

    const workers = results.map((w) => ({
      _id: w._id,
      fullName: w.fullName,
      phone: w.phone,
      city: w.location && w.location.city,
      travelRadiusKm: (w.location && w.location.travelRadiusKm) || null,
      distanceKm: Math.round((w.distanceMeters / 1000) * 100) / 100,
    }));

    return ok(res, { workers, count: workers.length }, 'Nearby trial-eligible workers');
  } catch (err) {
    next(err);
  }
}

// POST /api/admin/trial/assign
// body: { workerId, hostName, hostPhone, lat, lng, address?, category,
//         subcategory?, jobDescription, scheduledTime? }
// (host may also be supplied nested as { host: { name, phone } })
async function assignTrial(req, res, next) {
  try {
    const b = req.body || {};
    const hostName = (b.host && b.host.name) || b.hostName;
    const hostPhone = (b.host && b.host.phone) || b.hostPhone;
    const { workerId, lat, lng, address, category, subcategory, jobDescription, scheduledTime } = b;

    if (!workerId) return fail(res, 'workerId is required', 422);
    if (!hostName || !String(hostName).trim()) return fail(res, 'hostName is required', 422);
    if (!hostPhone || !String(hostPhone).trim()) return fail(res, 'hostPhone is required', 422);
    if (!isValidCategory(category)) return fail(res, `Invalid service category: ${category}`, 422);
    if (subcategory && !isValidSubcategory(category, subcategory)) {
      return fail(res, `Invalid subcategory "${subcategory}" for category "${category}"`, 422);
    }
    if (!jobDescription || !String(jobDescription).trim()) return fail(res, 'jobDescription is required', 422);
    if (!validCoord(Number(lat), Number(lng))) return fail(res, 'Valid numeric lat and lng are required', 422);

    const worker = await Worker.findById(workerId);
    if (!worker) return fail(res, 'Worker not found', 404);
    if (worker.status !== 'pending_trial') {
      return fail(res, `Worker must be in "pending_trial" to be assigned a trial (current: ${worker.status})`, 409);
    }

    const now = new Date();
    const job = await TrialJob.create({
      worker: worker._id,
      assignedBy: req.admin._id,
      host: { name: String(hostName).trim(), phone: String(hostPhone).trim() },
      category,
      subcategory: subcategory || null,
      jobDescription: String(jobDescription).trim(),
      scheduledTime: scheduledTime ? new Date(scheduledTime) : null,
      location: { type: 'Point', coordinates: [Number(lng), Number(lat)] },
      address: address || '',
      pricing: computeTrialPrice(category),
      status: 'assigned',
      offerExpiresAt: new Date(now.getTime() + OFFER_WINDOW_SECONDS * 1000),
    });

    await transitionWorker(worker, 'trial_assigned', {
      actor: req.admin.email,
      reason: 'Trial job assigned by admin',
      trialJob: job._id,
    });

    // Real-time: push the offer to the worker's socket room…
    emitter.emitToWorker(worker._id, 'trial:assigned', {
      jobId: String(job._id),
      host: { name: job.host.name, address: job.address, lat: Number(lat), lng: Number(lng) },
      scheduledTime: job.scheduledTime,
      rate: job.pricing,
      offerExpiresAt: job.offerExpiresAt,
    });
    // Observability: was a socket actually joined to the room to receive it?
    // connected:false here means the app isn't holding a socket during the trial
    // phase (open it right after login, not only when going online) — the emit is fine.
    const socketConnected = await emitter.isWorkerConnected(worker._id);
    console.log(
      `🧪 [trial:assigned] emitted to room worker:${worker._id} · socket connected: ${socketConnected} · job ${job._id}`
    );
    // …and fire a push (mock) in case the app is backgrounded / socket not connected.
    await notifyWorker(worker, {
      title: 'New trial job offer 🧪',
      message: `A trial ${category} job is available. Open the app to accept before it expires.`,
    }).catch(() => {});

    return ok(res, { trialJob: trialAdminView(job) }, 'Trial job assigned', 201);
  } catch (err) {
    next(err);
  }
}

// GET /api/admin/trial/:id
async function getTrial(req, res, next) {
  try {
    const job = await TrialJob.findById(req.params.id).populate('worker', 'phone fullName status');
    if (!job) return fail(res, 'Trial job not found', 404);

    const view = trialAdminView(job);
    // Convenience for demos: if feedback is still open, hand back a live link.
    if (job.status === 'completed' && !job.feedback.submittedAt) {
      view.feedbackLink = tokenService.buildLink(tokenService.sign(job._id));
    }
    return ok(res, { trialJob: view }, 'Trial job detail');
  } catch (err) {
    next(err);
  }
}

// POST /api/admin/trial/:id/decision   { decision: 'approve'|'reject', notes? }
// Manual finalisation for `conditional` (or not-yet-reviewed) trials.
async function decideTrial(req, res, next) {
  try {
    const { decision, notes } = req.body || {};
    if (!['approve', 'reject'].includes(decision)) {
      return fail(res, "decision must be 'approve' or 'reject'", 422);
    }
    if (decision === 'reject' && (!notes || !String(notes).trim())) {
      return fail(res, 'A reason (notes) is required to reject', 422);
    }

    const job = await TrialJob.findById(req.params.id);
    if (!job) return fail(res, 'Trial job not found', 404);

    const worker = await Worker.findById(job.worker);
    if (!worker) return fail(res, 'Worker not found', 404);
    // Only a worker still awaiting a verdict can be decided (strong_pass/fail
    // already moved them to approved/rejected automatically).
    if (worker.status !== 'trial_completed') {
      return fail(res, `Worker is not awaiting a trial decision (current: ${worker.status})`, 409);
    }

    job.feedback.reviewedByAdmin = req.admin._id;
    job.feedback.finalizedAt = new Date();
    await job.save();

    if (decision === 'approve') {
      await transitionWorker(worker, 'approved', {
        actor: req.admin.email,
        reason: `Trial approved by admin${notes ? ' — ' + String(notes).trim() : ''}`,
        trialJob: job._id,
      });
      await notifyWorker(worker, {
        title: "You're approved! 🎉",
        message: 'Your trial was approved. You can now start accepting jobs on Kaaryo.',
      }).catch(() => {});
      return ok(res, { workerStatus: worker.status }, 'Worker approved after trial');
    }

    await transitionWorker(worker, 'rejected', {
      actor: req.admin.email,
      reason: `Trial rejected by admin — ${String(notes).trim()}`,
      trialJob: job._id,
    });
    await notifyWorker(worker, {
      title: 'Trial review update',
      message: `Unfortunately your trial was not approved. Reason: ${String(notes).trim()}`,
    }).catch(() => {});
    return ok(res, { workerStatus: worker.status }, 'Worker rejected after trial');
  } catch (err) {
    next(err);
  }
}

module.exports = { trialQueue, nearbyTrialWorkers, assignTrial, getTrial, decideTrial };
