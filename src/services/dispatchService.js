const mongoose = require('mongoose');
const Worker = require('../models/Worker');
const ServiceRequest = require('../models/ServiceRequest');
const { notifyWorker } = require('./notificationService');
const emitter = require('../realtime/emitter');
const { offerView } = require('../utils/jobPayload');

/**
 * Dispatch engine for on-demand service requests.
 *
 * Model (mirrors ride-hailing / on-demand services):
 *  1. Broadcast the request to the top-K nearest ELIGIBLE workers within the
 *     current radius (a "wave").
 *  2. First worker to accept wins — enforced by an atomic conditional update
 *     (the distributed lock: first write wins, everyone else gets a conflict).
 *  3. If nobody accepts before the wave times out, expand the radius and
 *     broadcast a new wave to freshly-in-range workers.
 *  4. If the max radius is reached with no acceptance, the request expires.
 */

// ── Config (env-overridable) ─────────────────────────────────
const INITIAL_RADIUS_KM = Number(process.env.DISPATCH_INITIAL_RADIUS_KM || 3);
const RADIUS_INCREMENT_KM = Number(process.env.DISPATCH_RADIUS_INCREMENT_KM || 3);
const MAX_RADIUS_KM = Number(process.env.DISPATCH_MAX_RADIUS_KM || 15);
const BATCH_SIZE = Number(process.env.DISPATCH_BATCH_SIZE || 10);
const WAVE_TIMEOUT_SECONDS = Number(process.env.DISPATCH_WAVE_TIMEOUT_SECONDS || 30);
const SWEEP_INTERVAL_SECONDS = Number(process.env.DISPATCH_SWEEP_INTERVAL_SECONDS || 5);

// Eligibility filter for a worker to receive an offer for `category`/`subcategory`.
// Handles both the new `expertise` model and legacy onboarding `work.cleaningTypes`.
function eligibilityQuery(category, subcategory, excludeWorkerIds) {
  const expertiseMatch = {
    expertise: {
      $elemMatch: subcategory ? { category, subcategories: subcategory } : { category },
    },
  };

  const orClauses = [expertiseMatch];
  // Legacy cleaning workers who never edited expertise: fall back to work.cleaningTypes.
  if (category === 'cleaning') {
    orClauses.push(subcategory ? { 'work.cleaningTypes': subcategory } : { 'work.cleaningTypes.0': { $exists: true } });
  }

  return {
    status: 'approved',
    'availability.isOnline': true,
    activeRequest: null, // load balancing: don't offer to a worker already on a job
    _id: { $nin: (excludeWorkerIds || []).map((id) => new mongoose.Types.ObjectId(String(id))) },
    $or: orClauses,
  };
}

// Find the nearest eligible workers within `radiusKm`, excluding already-offered ones.
// Two radius constraints apply:
//   1. the request's current search radius (how far WE look this wave), and
//   2. the worker's own onboarding travel radius (how far THEY agreed to go) —
//      a worker who chose "2 km" is never offered a job 5 km away.
async function findNearbyWorkers(request, radiusKm, excludeWorkerIds) {
  const [lng, lat] = request.location.coordinates;
  const results = await Worker.aggregate([
    {
      $geoNear: {
        near: { type: 'Point', coordinates: [lng, lat] },
        distanceField: 'distanceMeters',
        maxDistance: radiusKm * 1000,
        spherical: true,
        query: eligibilityQuery(request.category, request.subcategory, excludeWorkerIds),
      },
    },
    // Enforce the worker's willingness-to-travel (location.travelRadiusKm, in km).
    // If a worker somehow has none set, fall back to the search radius (no extra limit).
    {
      $match: {
        $expr: {
          $lte: [
            '$distanceMeters',
            { $multiply: [{ $ifNull: ['$location.travelRadiusKm', radiusKm] }, 1000] },
          ],
        },
      },
    },
    { $limit: BATCH_SIZE },
    { $project: { _id: 1, fullName: 1, phone: 1, rating: 1, distanceMeters: 1, 'location.travelRadiusKm': 1 } },
  ]);
  return results;
}

// Broadcast one wave of offers. Returns the number of NEW workers offered.
async function dispatchWave(request) {
  const alreadyOffered = request.offers.map((o) => o.worker);
  const workers = await findNearbyWorkers(request, request.radiusKm, alreadyOffered);

  if (!workers.length) return 0;

  const now = new Date();
  workers.forEach((w) => {
    request.offers.push({
      worker: w._id,
      distanceKm: Math.round((w.distanceMeters / 1000) * 100) / 100,
      wave: request.wave,
      status: 'offered',
      offeredAt: now,
    });
  });
  request.dispatchExpiresAt = new Date(now.getTime() + WAVE_TIMEOUT_SECONDS * 1000);
  await request.save();

  workers.forEach((w) => {
    // Primary path: push the offer live to the worker's socket (no polling).
    emitter.emitToWorker(w._id, 'job:offer', offerView(request, w._id));
    // Fallback path: mock push/SMS (stands in for FCM when the app is backgrounded).
    notifyWorker(
      { phone: w.phone, _id: w._id },
      {
        title: 'New job request nearby',
        message: `${request.category}${request.subcategory ? ' (' + request.subcategory + ')' : ''} · ${Math.round((w.distanceMeters / 1000) * 10) / 10} km away`,
      }
    ).catch(() => {});
  });

  return workers.length;
}

// Create + kick off dispatch for a brand-new request. Mutates/saves `request`.
async function startDispatch(request) {
  request.initialRadiusKm = request.initialRadiusKm || INITIAL_RADIUS_KM;
  request.maxRadiusKm = request.maxRadiusKm || MAX_RADIUS_KM;
  request.radiusKm = request.initialRadiusKm;
  request.wave = 1;
  const offered = await dispatchWave(request);
  return offered;
}

// Called by the sweeper when a wave has timed out with no acceptance.
async function expandOrExpire(request) {
  // Expand radius if we still have room.
  if (request.radiusKm < request.maxRadiusKm) {
    request.radiusKm = Math.min(request.radiusKm + RADIUS_INCREMENT_KM, request.maxRadiusKm);
    request.wave += 1;
    const offered = await dispatchWave(request);
    // Even if this wave found nobody new, keep searching until max radius is reached.
    if (offered === 0 && request.radiusKm >= request.maxRadiusKm) {
      return expire(request);
    }
    return { action: 'expanded', radiusKm: request.radiusKm, wave: request.wave, newlyOffered: offered };
  }
  return expire(request);
}

async function expire(request) {
  request.status = 'expired';
  request.expiredAt = new Date();
  const notify = [];
  request.offers.forEach((o) => {
    if (o.status === 'offered') {
      o.status = 'missed';
      notify.push(o.worker);
    }
  });
  await request.save();
  // Real-time: clear the expired offer from any worker still showing it.
  notify.forEach((workerId) => emitter.emitToWorker(workerId, 'job:expired', { id: String(request._id) }));
  return { action: 'expired' };
}

/**
 * A worker accepts a request. First-to-accept-wins via an atomic conditional
 * update — the second concurrent accept matches nothing and gets a conflict.
 * Returns { ok: true, request } or { ok: false, reason }.
 */
async function acceptRequest(requestId, worker) {
  if (worker.status !== 'approved') {
    return { ok: false, code: 403, reason: 'Only approved workers can accept jobs' };
  }
  if (worker.activeRequest) {
    return { ok: false, code: 409, reason: 'You already have an active job. Complete it first.' };
  }

  const now = new Date();
  // Atomic: only succeeds if still searching AND this worker was actually offered it.
  const updated = await ServiceRequest.findOneAndUpdate(
    { _id: requestId, status: 'searching', 'offers.worker': worker._id },
    { $set: { status: 'in_progress', acceptedBy: worker._id, acceptedAt: now } },
    { new: true }
  );

  if (!updated) {
    return { ok: false, code: 409, reason: 'This job is no longer available (already taken or expired)' };
  }

  // Mark offer statuses: accepted for winner, missed for the rest.
  updated.offers.forEach((o) => {
    if (String(o.worker) === String(worker._id)) o.status = 'accepted';
    else if (o.status === 'offered') o.status = 'missed';
  });
  await updated.save();

  // Bind the worker to this job so they won't receive further offers.
  worker.activeRequest = updated._id;
  await worker.save();

  // Real-time: tell every other offered worker the job is gone so it vanishes
  // from their screen instantly (no polling).
  updated.offers.forEach((o) => {
    if (String(o.worker) !== String(worker._id)) {
      emitter.emitToWorker(o.worker, 'job:taken', { id: String(updated._id) });
    }
  });

  return { ok: true, request: updated };
}

// Worker declines a specific offer.
async function declineRequest(requestId, worker) {
  const request = await ServiceRequest.findById(requestId);
  if (!request) return { ok: false, code: 404, reason: 'Request not found' };
  const offer = request.offers.find((o) => String(o.worker) === String(worker._id));
  if (!offer) return { ok: false, code: 404, reason: 'You were not offered this job' };
  if (offer.status === 'offered') offer.status = 'declined';
  await request.save();
  return { ok: true, request };
}

// Worker marks the on-site work done. This does NOT complete the job — it
// moves to pending_rating and the worker stays bound (blocked from new
// offers) until they submit a rating via rateJob().
async function markWorkDone(requestId, worker) {
  const request = await ServiceRequest.findById(requestId);
  if (!request) return { ok: false, code: 404, reason: 'Request not found' };
  if (String(request.acceptedBy) !== String(worker._id)) {
    return { ok: false, code: 403, reason: 'This job is not assigned to you' };
  }
  if (request.status !== 'in_progress') {
    return { ok: false, code: 409, reason: `Cannot complete a ${request.status} job` };
  }
  request.status = 'pending_rating';
  request.workDoneAt = new Date();
  await request.save();
  return { ok: true, request };
}

// Worker submits their 1-5 rating for the job — this is what actually
// finalizes completion (frees the worker + bumps jobsCompleted).
async function rateJob(requestId, worker, rating) {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return { ok: false, code: 422, reason: 'Rating must be a whole number between 1 and 5' };
  }

  const request = await ServiceRequest.findById(requestId);
  if (!request) return { ok: false, code: 404, reason: 'Request not found' };
  if (String(request.acceptedBy) !== String(worker._id)) {
    return { ok: false, code: 403, reason: 'This job is not assigned to you' };
  }
  if (request.status !== 'pending_rating') {
    return {
      ok: false,
      code: 409,
      reason: request.status === 'completed'
        ? 'You already rated this job'
        : `Mark the job complete before rating it (current status: ${request.status})`,
    };
  }

  request.jobRating = rating;
  request.ratedAt = new Date();
  request.status = 'completed';
  request.completedAt = new Date();
  await request.save();

  // Free the worker and bump their completed-jobs counter (feeds the profile card).
  worker.activeRequest = null;
  worker.jobsCompleted = (worker.jobsCompleted || 0) + 1;
  await worker.save();

  return { ok: true, request };
}

// Customer cancels. Frees the assigned worker if one was bound.
async function cancelRequest(requestId) {
  const request = await ServiceRequest.findById(requestId);
  if (!request) return { ok: false, code: 404, reason: 'Request not found' };
  if (request.status === 'pending_rating') {
    return { ok: false, code: 409, reason: 'Work is already done for this job — it just needs the worker\'s rating to finalize, so it can no longer be cancelled' };
  }
  if (['completed', 'cancelled', 'expired'].includes(request.status)) {
    return { ok: false, code: 409, reason: `Request already ${request.status}` };
  }
  const assignedWorkerId = request.acceptedBy;
  request.status = 'cancelled';
  request.cancelledAt = new Date();
  await request.save();

  if (assignedWorkerId) {
    await Worker.updateOne({ _id: assignedWorkerId, activeRequest: request._id }, { $set: { activeRequest: null } });
  }
  return { ok: true, request };
}

// ── Background sweeper: expand/expire timed-out searching requests ─────────
let sweeperTimer = null;
let sweeping = false;

async function sweepOnce() {
  if (sweeping) return; // avoid overlapping runs
  sweeping = true;
  try {
    const due = await ServiceRequest.find({
      status: 'searching',
      dispatchExpiresAt: { $lte: new Date() },
    }).limit(50);

    for (const request of due) {
      try {
        await expandOrExpire(request);
      } catch (err) {
        console.error('Dispatch sweep error for request', String(request._id), err.message);
      }
    }
  } catch (err) {
    console.error('Dispatch sweeper error:', err.message);
  } finally {
    sweeping = false;
  }
}

function startSweeper() {
  if (sweeperTimer) return;
  sweeperTimer = setInterval(sweepOnce, SWEEP_INTERVAL_SECONDS * 1000);
  console.log(`🛰️  Dispatch sweeper running every ${SWEEP_INTERVAL_SECONDS}s (radius ${INITIAL_RADIUS_KM}→${MAX_RADIUS_KM}km, wave timeout ${WAVE_TIMEOUT_SECONDS}s)`);
}

function stopSweeper() {
  if (sweeperTimer) clearInterval(sweeperTimer);
  sweeperTimer = null;
}

module.exports = {
  startDispatch,
  acceptRequest,
  declineRequest,
  markWorkDone,
  rateJob,
  cancelRequest,
  findNearbyWorkers,
  startSweeper,
  stopSweeper,
  sweepOnce,
  config: {
    INITIAL_RADIUS_KM, RADIUS_INCREMENT_KM, MAX_RADIUS_KM,
    BATCH_SIZE, WAVE_TIMEOUT_SECONDS, SWEEP_INTERVAL_SECONDS,
  },
};
