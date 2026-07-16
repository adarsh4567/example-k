const ServiceRequest = require('../models/ServiceRequest');
const { ok, fail } = require('../utils/response');
const dispatch = require('../services/dispatchService');
const { offerView, assignedView } = require('../utils/jobPayload');

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

// GET /api/jobs/mine  — the worker's active + past jobs
async function myJobs(req, res, next) {
  try {
    const worker = req.worker;
    const requests = await ServiceRequest.find({ acceptedBy: worker._id })
      .sort({ acceptedAt: -1 })
      .limit(50);
    // pending_rating stays "active" (not history) — the worker still owes a
    // rating before the job is done. This also lets the app re-show the
    // rating card on resume if it was killed before the rating was submitted.
    const active = requests
      .filter((r) => r.status === 'in_progress' || r.status === 'pending_rating')
      .map(assignedView);
    const history = requests
      .filter((r) => ['completed', 'cancelled', 'expired'].includes(r.status))
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

// POST /api/jobs/:id/complete
// Marks the on-site work done. The job is NOT finished yet — it moves to
// pending_rating and the app should immediately show the rating card.
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
  updateAvailability, availableJobs, myJobs, acceptJob, declineJob, completeJob, rateJob,
};
