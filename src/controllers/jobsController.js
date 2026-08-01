const ServiceRequest = require('../models/ServiceRequest');
const { ok, fail } = require('../utils/response');
const dispatch = require('../services/dispatchService');
const { offerView, assignedView } = require('../utils/jobPayload');
const { trackingView } = require('../services/trackingService');

function validCoord(lat, lng) {
  return (
    typeof lat === 'number' && typeof lng === 'number' &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
  );
}

// PUT /api/jobs/availability  { isOnline, lat, lng }
// The worker app calls this to go online/offline and to send its live location
// (a location heartbeat). A worker must be online + located to receive offers.
async function updateAvailability(req, res, next) {
  try {
    const worker = req.worker;
    const { isOnline, lat, lng } = req.body;

    if (typeof isOnline !== 'undefined') {
      worker.availability = worker.availability || {};
      worker.availability.isOnline = !!isOnline;
    }
    if (lat !== undefined || lng !== undefined) {
      if (!validCoord(Number(lat), Number(lng))) {
        return fail(res, 'Valid numeric lat and lng are required', 422);
      }
      worker.currentLocation = { type: 'Point', coordinates: [Number(lng), Number(lat)] };
    }
    worker.availability = worker.availability || {};
    worker.availability.lastSeenAt = new Date();
    await worker.save();

    return ok(res, {
      availability: {
        isOnline: worker.availability.isOnline || false,
        lastSeenAt: worker.availability.lastSeenAt,
        location: worker.currentLocation || null,
      },
    }, 'Availability updated');
  } catch (err) {
    next(err);
  }
}

// GET /api/jobs/available  — pending offers currently open to this worker
async function availableJobs(req, res, next) {
  try {
    const worker = req.worker;
    const requests = await ServiceRequest.find({
      status: 'searching',
      offers: { $elemMatch: { worker: worker._id, status: 'offered' } },
    }).sort({ createdAt: -1 });

    return ok(res, { jobs: requests.map((r) => offerView(r, worker._id)) }, 'Available jobs');
  } catch (err) {
    next(err);
  }
}

// The date a "past" job should be ordered by for history: when it actually
// finished, whichever way it finished (completed/cancelled/expired).
function historySortDate(r) {
  return r.completedAt || r.cancelledAt || r.expiredAt || r.updatedAt;
}

// GET /api/jobs/mine  — the worker's active + past jobs
async function myJobs(req, res, next) {
  try {
    const worker = req.worker;
    // updatedAt is a reasonable recency proxy at the DB level for the initial
    // fetch+limit; exact ordering within active/history is enforced below.
    const requests = await ServiceRequest.find({ acceptedBy: worker._id })
      .sort({ updatedAt: -1 })
      .limit(50);

    // pending_rating stays "active" (not history) — the worker still owes a
    // rating before the job is done. This also lets the app re-show the
    // rating card on resume if it was killed before the rating was submitted.
    const active = requests
      .filter((r) => r.status === 'in_progress' || r.status === 'pending_rating')
      .sort((a, b) => new Date(b.acceptedAt) - new Date(a.acceptedAt))
      .map(assignedView);

    // Newest-first by completedAt — this is what "Recent Transactions" (the
    // first 5 entries) relies on to show recent jobs, not arbitrary ones.
    const history = requests
      .filter((r) => ['completed', 'cancelled', 'expired'].includes(r.status))
      .sort((a, b) => new Date(historySortDate(b)) - new Date(historySortDate(a)))
      .map(assignedView);

    return ok(res, { active, history }, 'Your jobs');
  } catch (err) {
    next(err);
  }
}

// POST /api/jobs/:id/accept
async function acceptJob(req, res, next) {
  try {
    const result = await dispatch.acceptRequest(req.params.id, req.worker);
    if (!result.ok) return fail(res, result.reason, result.code || 400);
    return ok(res, { job: assignedView(result.request) }, 'Job accepted — you are now in progress');
  } catch (err) {
    next(err);
  }
}

// POST /api/jobs/:id/decline
async function declineJob(req, res, next) {
  try {
    const result = await dispatch.declineRequest(req.params.id, req.worker);
    if (!result.ok) return fail(res, result.reason, result.code || 400);
    return ok(res, {}, 'Job declined');
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/jobs/:id/location   { lat, lng, heading?, speedKmh?, accuracy? }
 *
 * Live position while travelling to the customer. Accepted only between accept
 * and start; the server geofences it and pushes the customer's map.
 *
 * A throttled ping (they arrive faster than the server's floor) answers 200 with
 * `throttled:true`, not an error — see MIN_PING_INTERVAL_MS in trackingConfig
 * for why. The app should treat both the same and just keep pinging.
 */
async function updateJobLocation(req, res, next) {
  try {
    const result = await dispatch.recordWorkerLocation(req.params.id, req.worker, req.body || {});
    if (!result.ok) return fail(res, result.reason, result.code || 400);
    return ok(
      res,
      {
        throttled: result.throttled,
        arrivalStatus: result.arrivalStatus,
        arrivalStatusChanged: result.changed,
        tracking: trackingView(result.request.tracking),
      },
      result.throttled ? 'Ping throttled — position unchanged' : 'Location updated'
    );
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/jobs/:id/start
 *
 * The worker reached the address and is beginning the work. This is what moves
 * the job from "on the way" to "in progress" on the customer's screen, and what
 * unlocks the Complete button in the worker app.
 */
async function startJob(req, res, next) {
  try {
    const result = await dispatch.startWork(req.params.id, req.worker);
    if (!result.ok) return fail(res, result.reason, result.code || 400);
    return ok(
      res,
      { job: assignedView(result.request) },
      result.alreadyStarted ? 'This job is already started' : 'Job started — the customer has been notified'
    );
  } catch (err) {
    next(err);
  }
}

// POST /api/jobs/:id/complete
// Marks the on-site work done. The job is NOT finished yet — it moves to
// pending_rating and the app should immediately show the rating card.
// Requires the job to have been STARTED first (see TRACKING_REQUIRE_JOB_START).
async function completeJob(req, res, next) {
  try {
    const result = await dispatch.markWorkDone(req.params.id, req.worker);
    if (!result.ok) return fail(res, result.reason, result.code || 400);
    return ok(
      res,
      { job: assignedView(result.request) },
      'Work marked as done — please rate this job to finish'
    );
  } catch (err) {
    next(err);
  }
}

// POST /api/jobs/:id/rate  { rating: 1-5 }
// This is what actually completes the job (frees the worker for new offers).
async function rateJob(req, res, next) {
  try {
    const { rating } = req.body;
    const result = await dispatch.rateJob(req.params.id, req.worker, Number(rating));
    if (!result.ok) return fail(res, result.reason, result.code || 400);
    return ok(res, { job: assignedView(result.request) }, 'Job completed — thanks for your rating');
  } catch (err) {
    next(err);
  }
}

module.exports = {
  updateAvailability, availableJobs, myJobs, acceptJob, declineJob,
  updateJobLocation, startJob, completeJob, rateJob,
};
