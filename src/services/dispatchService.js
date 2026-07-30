const mongoose = require('mongoose');
const Worker = require('../models/Worker');
const ServiceRequest = require('../models/ServiceRequest');
const { notifyWorker } = require('./notificationService');
const emitter = require('../realtime/emitter');
const { offerView } = require('../utils/jobPayload');
const paymentService = require('./paymentService');
const {
  INITIAL_RADIUS_KM,
  RADIUS_INCREMENT_KM,
  MAX_RADIUS_KM,
  BATCH_SIZE,
  WAVE_TIMEOUT_SECONDS,
  SEARCH_WINDOW_SECONDS,
  SWEEP_INTERVAL_SECONDS,
  MAX_ATTEMPTS,
} = require('../config/dispatchConfig');

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
 *  4. The whole search is capped at SEARCH_WINDOW_SECONDS (the customer's
 *     1-minute timer). When it elapses — or the max radius runs out first — the
 *     request expires and the customer may RETRY, which re-runs the search from
 *     the initial radius as a new `attempt`.
 *
 * Waves vs. the window. These are two independent timers and it matters which
 * one owns the outcome: waves decide how far we look and are free to change
 * (more waves, different radius steps), while the window decides when the
 * customer gets an answer. The window always wins — a wave dispatched with 10s
 * left on the clock gets 10s, not a full WAVE_TIMEOUT_SECONDS, because the
 * customer was promised a result in a minute.
 *
 * The customer's live view. Every state change here pushes a `request:*` event to
 * the customer's socket room. That's the primary channel; the polling endpoint
 * (GET the request) returns the identical serializer and is the fallback, so a
 * customer app that never opens a socket still works — just less promptly.
 */

// Eligibility filter for a worker to receive an offer for `category`/`subcategory`.
// Handles both the new `expertise` model and legacy onboarding `work.cleaningTypes`.
function eligibilityQuery(category, subcategory, excludeWorkerIds) {
  const expertiseMatch = {
    expertise: {
      $elemMatch: subcategory ? { category, subcategories: subcategory } : { category },
    },
  };

  const orClauses = [expertiseMatch];

  // Fallback for workers whose `expertise` array is still empty — anyone who
  // onboarded before it started being persisted. Their trade + skills live on
  // `work.primaryCategory` / `work.cleaningTypes`.
  //
  // This fallback used to be gated on `category === 'cleaning'`, from when the
  // funnel was cleaning-only. That made an approved electrician with an empty
  // expertise array match NEITHER clause, so dispatch could never offer them a
  // job — they were fully approved and certified but invisible. It now matches the
  // worker's own declared trade.
  const skillMatch = subcategory
    ? { 'work.cleaningTypes': subcategory }
    : { 'work.cleaningTypes.0': { $exists: true } };

  // `work.primaryCategory` is absent on documents created before that field
  // existed; those are cleaning workers by definition, so treat missing as
  // 'cleaning' rather than excluding them.
  // ({ field: null } matches both an explicit null and a missing field.)
  const categoryIsOrDefaults =
    category === 'cleaning'
      ? { $or: [{ 'work.primaryCategory': 'cleaning' }, { 'work.primaryCategory': null }] }
      : { 'work.primaryCategory': category };

  orClauses.push({ $and: [categoryIsOrDefaults, skillMatch] });

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

/**
 * Push the current state of a request to the customer's app.
 *
 * Best-effort by design: a socket failure must never roll back or block a
 * dispatch decision that has already been persisted, so this swallows its own
 * errors. The customer's polling GET is the safety net.
 *
 * Required lazily to keep the require graph acyclic — utils/requestPayload pulls
 * in paymentService, which pulls in the ServiceRequest model, and importing it at
 * module scope here would tangle dispatch into that chain at load time.
 */
async function pushToCustomer(request, event, extra = {}) {
  if (!request.user) return; // legacy unauthenticated request — nobody to notify
  try {
    const { customerView } = require('../utils/requestPayload');
    emitter.emitToUser(request.user, event, { request: await customerView(request), ...extra });
  } catch (err) {
    console.error(`Customer push failed (${event}) for request ${request._id}:`, err.message);
  }
}

// Broadcast one wave of offers. Returns the number of NEW workers offered.
async function dispatchWave(request) {
  // Exclude only workers already offered THIS attempt. A retry is meant to reach
  // the same neighbourhood again — the workers who ignored or missed the previous
  // attempt are exactly the ones most likely to be free now, and excluding them
  // made a retry in a thin-supply area a guaranteed second failure.
  const attempt = request.attempt || 1;
  const alreadyOffered = request.offers.filter((o) => (o.attempt || 1) === attempt).map((o) => o.worker);
  const workers = await findNearbyWorkers(request, request.radiusKm, alreadyOffered);

  const now = new Date();
  workers.forEach((w) => {
    request.offers.push({
      worker: w._id,
      distanceKm: Math.round((w.distanceMeters / 1000) * 100) / 100,
      wave: request.wave,
      attempt,
      status: 'offered',
      offeredAt: now,
    });
  });

  // Persist the wave — the timer AND the radiusKm/wave the caller just set —
  // even when this wave found nobody.
  //
  // This used to `return 0` before saving whenever no workers matched, which
  // silently stranded the request:
  //   • dispatchExpiresAt was never written, so the sweeper's
  //     `dispatchExpiresAt: {$lte: now}` could never match it (that predicate
  //     skips missing fields) — the radius never expanded and the request never
  //     expired. It sat in `searching` forever.
  //   • radiusKm/wave were never written either, so the customer's GET reported
  //     `wave: 0` and no `radiusKm` while the POST response (built from the
  //     in-memory doc) said radiusKm 3 / wave 1.
  // When an EXPANDING wave found nobody it was worse: expandOrExpire had already
  // bumped radiusKm/wave in memory, so the stale — already elapsed —
  // dispatchExpiresAt stayed in the DB and the sweeper re-picked the same
  // request every 5s indefinitely, re-running the geo query each time.
  //
  // Clamped to the attempt's own deadline: a wave must never outlive the search
  // window the customer is watching count down. Without the clamp a wave
  // dispatched at t=45s would hold the request in `searching` until t=75s — the
  // customer's timer would hit zero while the server was still looking, and the
  // "no one accepted, retry?" screen would be a lie for 15 seconds.
  const waveEnd = new Date(now.getTime() + WAVE_TIMEOUT_SECONDS * 1000);
  request.dispatchExpiresAt =
    request.searchExpiresAt && request.searchExpiresAt < waveEnd ? request.searchExpiresAt : waveEnd;
  await request.save();

  // Tell the customer how the search is going — new radius, how many
  // professionals this wave reached — even on an empty wave, since "still
  // looking, now 6 km out" is exactly what the waiting screen should say.
  await pushToCustomer(request, 'request:searching', { newlyOffered: workers.length });

  if (!workers.length) return 0;

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
  request.attempt = request.attempt || 1;
  // Start the customer's clock here rather than at row creation, so a slow
  // first geo query doesn't eat into the minute they were promised.
  const startedAt = new Date();
  request.searchStartedAt = startedAt;
  request.searchExpiresAt = new Date(startedAt.getTime() + SEARCH_WINDOW_SECONDS * 1000);
  const offered = await dispatchWave(request);
  return offered;
}

/**
 * Re-run the search on an expired request, as a new attempt.
 *
 * Implemented as a re-dispatch of the SAME row rather than a cloned request, so
 * the customer app keeps one id across retries (its socket subscription, its
 * open screen and its deep links all stay valid) and the price quoted at
 * creation is carried forward instead of being re-derived from a rate card that
 * may have moved in the meantime.
 *
 * The status flip is an atomic conditional update for the same reason accepting
 * is: the sweeper may be expiring this row at the same moment, and two taps on
 * "Retry" must not start two concurrent searches over one request. Only a row
 * that is still `expired` AND still under the attempt cap can be claimed — so
 * losers get a clean conflict instead of a duplicated dispatch.
 *
 * @returns {{ok:true, request, offered, attempt}} | {{ok:false, code, reason}}
 */
async function retryRequest(requestId) {
  const now = new Date();
  const claimed = await ServiceRequest.findOneAndUpdate(
    { _id: requestId, status: 'expired', attempt: { $lt: MAX_ATTEMPTS } },
    {
      $set: {
        status: 'searching',
        searchStartedAt: now,
        searchExpiresAt: new Date(now.getTime() + SEARCH_WINDOW_SECONDS * 1000),
        dispatchExpiresAt: null,
        expiredAt: null,
      },
      // `attempt` scopes which offers count as "already tried"; `wave` stays
      // monotonic across attempts so it remains a stable ordering key on offers.
      $inc: { attempt: 1, wave: 1 },
    },
    { new: true }
  );

  if (!claimed) {
    // Distinguish the two ways the guard can fail — "try again" and "you're out
    // of retries" need different words on the customer's screen.
    const current = await ServiceRequest.findById(requestId);
    if (!current) return { ok: false, code: 404, reason: 'Request not found' };
    if (current.status !== 'expired') {
      return {
        ok: false,
        code: 409,
        reason: current.status === 'searching'
          ? 'This request is already searching for a professional'
          : `Cannot retry a ${current.status} request`,
      };
    }
    return {
      ok: false,
      code: 429,
      reason: `No professionals found after ${MAX_ATTEMPTS} attempts. Please raise a new request, or try a wider area.`,
    };
  }

  // Fresh attempt, so search from the initial radius again — the point of a retry
  // is a new sweep of the nearby supply, not a continuation of the far-out one.
  claimed.radiusKm = claimed.initialRadiusKm || INITIAL_RADIUS_KM;
  const offered = await dispatchWave(claimed);
  return { ok: true, request: claimed, offered, attempt: claimed.attempt };
}

// Called by the sweeper when a wave has timed out with no acceptance.
async function expandOrExpire(request) {
  // The search window is the hard stop and it outranks the radius: once the
  // customer's minute is up they get an answer, however much unexplored radius
  // is left. (Checked first for that reason — the old code could only ever
  // expire at MAX_RADIUS_KM, which with a 15 km ceiling meant a search ran
  // ~2.5 minutes before the customer was told it had failed.)
  const now = new Date();
  if (request.searchExpiresAt && new Date(request.searchExpiresAt) <= now) {
    return expire(request, 'search_window_elapsed');
  }

  // Expand radius if we still have room.
  if (request.radiusKm < request.maxRadiusKm) {
    request.radiusKm = Math.min(request.radiusKm + RADIUS_INCREMENT_KM, request.maxRadiusKm);
    request.wave += 1;
    const offered = await dispatchWave(request);
    // Even if this wave found nobody new, keep searching until max radius is reached.
    if (offered === 0 && request.radiusKm >= request.maxRadiusKm) {
      return expire(request, 'max_radius_reached');
    }
    return { action: 'expanded', radiusKm: request.radiusKm, wave: request.wave, newlyOffered: offered };
  }
  return expire(request, 'max_radius_reached');
}

async function expire(request, reason = 'search_window_elapsed') {
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
  // Real-time: move the customer's screen to "no one available — retry?".
  // `canRetry` on the payload says whether the button should be live.
  await pushToCustomer(request, 'request:expired', { reason });
  return { action: 'expired', reason };
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

  // Real-time: swap the customer's countdown for the assigned-professional card.
  // The payload's `worker` block (name, phone, rating, distance) appears at this
  // transition and not before — pre-accept there is nobody to show.
  await pushToCustomer(updated, 'request:accepted');

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
  // Payment falls due the moment the work is physically done — deliberately not
  // at `completed`, which additionally requires the worker to submit their own
  // rating. Gating the customer's ability to pay on a tap only the worker can
  // make would strand the money for a reason the customer can't see or fix.
  paymentService.markDue(request);
  await request.save();

  // Real-time: this is the customer's cue to show "work done — pay ₹X".
  await pushToCustomer(request, 'request:work_done');
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

  // Real-time: the customer's job card moves to "completed". Payment may already
  // have been made (it fell due back at pending_rating) or may still be open —
  // `payment.payable` on the payload is what decides whether to keep the Pay
  // button on screen.
  await pushToCustomer(request, 'request:completed');

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
  const stillOffered = request.offers.filter((o) => o.status === 'offered').map((o) => o.worker);
  request.status = 'cancelled';
  request.cancelledAt = new Date();
  // Nothing was owed — the work never finished. (No cancellation fee exists yet;
  // if one is introduced it belongs here, as a `due` payment with its own amount.)
  request.offers.forEach((o) => {
    if (o.status === 'offered') o.status = 'missed';
  });
  await request.save();

  if (assignedWorkerId) {
    await Worker.updateOne({ _id: assignedWorkerId, activeRequest: request._id }, { $set: { activeRequest: null } });
  }

  // Real-time: pull the offer off the screen of every worker still weighing it.
  // Reuses `job:expired` rather than introducing a `job:cancelled` event, because
  // the worker app already handles that event and the meaning is identical from
  // their side — this job is gone, stop showing it. A new event would have meant a
  // worker-app change for no behavioural gain.
  //
  // Before this, cancelling a `searching` request left its offers sitting at
  // `offered` with nothing pushed, so the job stayed on every notified worker's
  // screen until their app happened to refetch GET /api/jobs/available (which
  // filters on status `searching` and would then drop it).
  //
  // The ASSIGNED worker is deliberately NOT sent this: `job:expired` means "an
  // offer vanished", and an accepted job disappearing is a different event their
  // app has no handler for. They see the cancellation on their next
  // GET /api/jobs/mine, exactly as before. Pushing it properly needs a
  // worker-side event and screen, which is out of scope here.
  stillOffered.forEach((workerId) => emitter.emitToWorker(workerId, 'job:expired', { id: String(request._id) }));

  await pushToCustomer(request, 'request:cancelled');
  return { ok: true, request };
}

// ── Background sweeper: expand/expire timed-out searching requests ─────────
let sweeperTimer = null;
let sweeping = false;

async function sweepOnce() {
  if (sweeping) return; // avoid overlapping runs
  sweeping = true;
  try {
    // Second clause self-heals stragglers: `searching` requests carrying no wave
    // timer at all. New requests can't reach this state any more (dispatchWave
    // always writes the timer), but rows stranded by the old early-return are
    // already in the DB and would otherwise stay `searching` forever. The age
    // floor keeps it off requests still mid-creation — there is a brief window
    // between createRequest's save and the first wave's save.
    // ({ field: null } matches both an explicit null and a missing field.)
    //
    // The third clause is the guarantee behind the customer's timer: a request
    // whose search window has elapsed is picked up even if its wave timer somehow
    // hasn't fired, so `searching` can never outlive `searchExpiresAt` by more
    // than one sweep interval. Since dispatchWave clamps every wave to the window
    // this is belt-and-braces, but the promise it backs — a definite answer within
    // the minute — is the one the whole retry flow rests on.
    const now = new Date();
    const due = await ServiceRequest.find({
      status: 'searching',
      $or: [
        { dispatchExpiresAt: { $lte: now } },
        {
          dispatchExpiresAt: null,
          createdAt: { $lte: new Date(now.getTime() - WAVE_TIMEOUT_SECONDS * 1000) },
        },
        { searchExpiresAt: { $lte: now } },
      ],
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
  console.log(
    `🛰️  Dispatch sweeper running every ${SWEEP_INTERVAL_SECONDS}s ` +
      `(radius ${INITIAL_RADIUS_KM}→${MAX_RADIUS_KM}km, wave timeout ${WAVE_TIMEOUT_SECONDS}s, ` +
      `search window ${SEARCH_WINDOW_SECONDS}s, up to ${MAX_ATTEMPTS} attempts)`
  );
}

function stopSweeper() {
  if (sweeperTimer) clearInterval(sweeperTimer);
  sweeperTimer = null;
}

module.exports = {
  startDispatch,
  retryRequest,
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
    BATCH_SIZE, WAVE_TIMEOUT_SECONDS, SEARCH_WINDOW_SECONDS,
    SWEEP_INTERVAL_SECONDS, MAX_ATTEMPTS,
  },
};
