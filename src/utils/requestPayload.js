const Worker = require('../models/Worker');
const { categoryName, subcategoryName } = require('../services/serviceCatalog');
const { MAX_ATTEMPTS } = require('../config/dispatchConfig');
const { PAYABLE_JOB_STATUS } = require('../services/paymentService');
const { trackingView } = require('../services/trackingService');

/**
 * The customer's view of a service request — the single serializer behind every
 * customer-facing REST response AND every `request:*` socket event, so the app
 * parses one shape no matter how the update reached it.
 *
 * Two things it deliberately does that the worker's view (utils/jobPayload) does
 * not:
 *
 *   It ships derived UI state — `secondsRemaining`, `canRetry`, `canCancel`,
 *   `payment.payable`. These are decisions about the flow (when may you retry?
 *   when is money collectable?) and they belong on the server, computed from the
 *   row, rather than re-implemented as client conditionals that drift out of
 *   sync with the dispatch rules the moment either side changes.
 *
 *   It never leaks the worker's earning split. `pricing.workerEarning` and
 *   `platformFee` are platform-internal; the customer sees only the total they
 *   owe. (The worker, symmetrically, never sees the customer's account id.)
 */

// Contact details are revealed to the customer only once a worker is bound to
// the job — the same pre-accept/post-accept privacy line the worker's view draws
// around the customer's phone number.
const WORKER_VISIBLE_STATUS = ['in_progress', 'pending_rating', 'completed'];

function secondsUntil(date, now) {
  if (!date) return null;
  return Math.max(0, Math.ceil((new Date(date).getTime() - now.getTime()) / 1000));
}

// Offers belonging to the attempt currently running. A retry starts a fresh
// count, so the "searching" screen shows how many professionals THIS attempt
// reached rather than a total that only ever grows.
function offersThisAttempt(request) {
  const attempt = request.attempt || 1;
  return (request.offers || []).filter((o) => (o.attempt || 1) === attempt);
}

/**
 * The single value the customer app renders its headline, badge and timeline
 * from. Composed here rather than in the app because it folds together three
 * things the client would otherwise have to combine correctly and identically on
 * every screen: `status`, `workStage`, and the geofence's `arrivalStatus`.
 *
 *   searching     → looking for a professional
 *   en_route      → assigned, on the way
 *   arriving_soon → close (see trackingConfig thresholds)
 *   arrived       → at the address, hasn't started yet
 *   working       → work under way (the worker tapped "Start job")
 *   work_done     → work finished, payment due
 *   completed / cancelled / expired → as the status
 *
 * Note the ORDER of the checks: `workStage === 'working'` outranks anything the
 * geofence says. Starting is a decision a human made; arrival is something GPS
 * guessed. Once the work has begun, a wandering fix must not be able to walk the
 * customer's screen back to "arriving soon".
 */
function stageOf(request) {
  if (request.status !== 'in_progress') {
    if (request.status === 'pending_rating') return 'work_done';
    return request.status; // searching | completed | cancelled | expired
  }
  if ((request.workStage || 'en_route') === 'working') return 'working';
  return (request.tracking && request.tracking.arrivalStatus) || 'en_route';
}

function paymentView(request) {
  const p = request.payment || {};
  return {
    status: p.status || 'not_due',
    // Straight answer to "should I show the Pay button?", so the app doesn't have
    // to combine job status and payment status itself.
    payable: PAYABLE_JOB_STATUS.includes(request.status) && ['due', 'failed'].includes(p.status),
    amount: p.amount ?? (request.pricing ? request.pricing.totalPrice : null),
    currency: p.currency || (request.pricing ? request.pricing.currency : null),
    method: p.method || null,
    orderId: p.orderId || null,
    transactionId: p.transactionId || null,
    attempts: p.attempts || 0,
    failureReason: p.failureReason || null,
    dueAt: p.dueAt || null,
    paidAt: p.paidAt || null,
  };
}

/**
 * @param {Document} request a ServiceRequest
 * @returns {Promise<object>} the customer-facing shape
 */
async function customerView(request) {
  const now = new Date();
  const attempt = request.attempt || 1;
  const searching = request.status === 'searching';

  const base = {
    id: request._id,
    status: request.status,
    // The composed value to render from — see stageOf(). `status` is unchanged
    // and still authoritative for payment/cancel/retry; `stage` is the finer
    // grain the tracking screen needs and is additive on top of it.
    stage: stageOf(request),
    workStage: request.status === 'in_progress' ? request.workStage || 'en_route' : null,

    category: request.category,
    categoryName: categoryName(request.category),
    subcategory: request.subcategory,
    subcategoryName: request.subcategory ? subcategoryName(request.category, request.subcategory) : null,
    jobDescription: request.jobDescription,

    // Customer sees only the total they'll pay — the platform/worker split is
    // worker- and platform-internal, not shown here.
    totalPrice: request.pricing ? request.pricing.totalPrice : null,
    currency: request.pricing ? request.pricing.currency : null,

    address: request.address,
    location: request.location,

    // ── Search telemetry for the "finding a professional" screen ──
    // Coalesced to null rather than left undefined so every key is always
    // present in the JSON — an absent field made clients render
    // "within undefined km".
    radiusKm: request.radiusKm ?? request.initialRadiusKm ?? null,
    wave: request.wave ?? null,
    attempt,
    maxAttempts: MAX_ATTEMPTS,
    workersNotified: offersThisAttempt(request).length,
    workersNotifiedTotal: (request.offers || []).length,

    // The authoritative countdown. Render the timer off `searchExpiresAt`
    // (absolute, server-issued) and treat `secondsRemaining` as a convenience
    // snapshot — that way a backgrounded or clock-skewed client still agrees
    // with the server about when the search dies.
    searchStartedAt: request.searchStartedAt || request.createdAt || null,
    searchExpiresAt: searching ? request.searchExpiresAt || null : null,
    secondsRemaining: searching ? secondsUntil(request.searchExpiresAt, now) : 0,

    // Server-decided affordances (see the header note).
    canRetry: request.status === 'expired' && attempt < MAX_ATTEMPTS,
    canCancel: ['searching', 'in_progress'].includes(request.status),

    payment: paymentView(request),

    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };

  if (WORKER_VISIBLE_STATUS.includes(request.status) && request.acceptedBy) {
    const worker = await Worker.findById(request.acceptedBy)
      .select('fullName phone rating jobsCompleted currentLocation profilePhoto');
    if (worker) {
      // Distance as measured when the offer went out — the accepted offer may be
      // from an earlier attempt, so match on the offer rather than the attempt.
      const acceptedOffer = (request.offers || []).find(
        (o) => String(o.worker) === String(worker._id) && o.status === 'accepted'
      ) || (request.offers || []).find((o) => String(o.worker) === String(worker._id));
      base.worker = {
        id: worker._id,
        name: worker.fullName,
        phone: worker.phone, // revealed after acceptance
        rating: worker.rating,
        jobsCompleted: worker.jobsCompleted,
        // Distance as measured when the offer went out — a fixed historical
        // figure. `liveDistanceKm` below (while live) is the moving one; both
        // are shipped while in progress because the assigned-professional card
        // shows the former and the map header the latter.
        distanceKm: acceptedOffer ? acceptedOffer.distanceKm : null,
      };

      /**
       * Live position is spliced in ONLY while the job is actively in progress.
       *
       * Before this gate, the tracking block — GPS coordinates, heading, live
       * distance — stayed on the payload for `pending_rating` and `completed`
       * too, because WORKER_VISIBLE_STATUS (which only ever controlled the
       * CONTACT reveal) was reused to gate this as well. The result: a job
       * finished last week would forever answer GET .../:id with the worker's
       * last GPS fix from right before they started working — a permanent
       * location pin on every customer's history screen, for every worker
       * they've ever booked. Contact info (name/phone/rating) is legitimately
       * historical — the customer may need to call about a finished job. A GPS
       * trail is not, and nothing about this feature needs it to outlive the
       * job.
       *
       * The key keeps its name and its GeoJSON shape so an app reading
       * `worker.location.coordinates` today starts getting a live value with no
       * change; everything else on the block is new and optional. Falls back to
       * the availability heartbeat until the first ping lands, so the marker has
       * somewhere to start rather than popping in from nowhere — but ONLY while
       * live, for the same reason: that heartbeat is itself a position that
       * shouldn't linger on a finished job's payload.
       */
      if (request.status === 'in_progress') {
        const live = trackingView(request.tracking, now);
        Object.assign(base.worker, live, {
          location: live.location || worker.currentLocation || null,
        });
      }
    }
    base.acceptedAt = request.acceptedAt;
    if (request.workStartedAt) base.workStartedAt = request.workStartedAt;
  }

  if (request.status === 'pending_rating') base.workDoneAt = request.workDoneAt;
  if (request.status === 'completed') {
    base.workDoneAt = request.workDoneAt;
    base.completedAt = request.completedAt;
  }
  if (request.status === 'cancelled') base.cancelledAt = request.cancelledAt;
  if (request.status === 'expired') base.expiredAt = request.expiredAt;

  return base;
}

// Compact form for list screens — same field names as the full view, minus the
// heavy bits (location, description, worker lookup), so a list of 50 requests
// doesn't fan out into 50 Worker queries.
function summaryView(request) {
  const now = new Date();
  const searching = request.status === 'searching';
  return {
    id: request._id,
    status: request.status,
    // Same derived value as the full view, and cheap — stageOf() reads only
    // fields already on the row, no worker lookup. Shipped here so the list card
    // and the detail screen can never disagree about whether the professional is
    // on the way, at the door, or already working.
    stage: stageOf(request),
    etaMinutes: (request.tracking && request.tracking.etaMinutes) ?? null,
    category: request.category,
    categoryName: categoryName(request.category),
    subcategory: request.subcategory,
    totalPrice: request.pricing ? request.pricing.totalPrice : null,
    currency: request.pricing ? request.pricing.currency : null,
    address: request.address,
    attempt: request.attempt || 1,
    secondsRemaining: searching ? secondsUntil(request.searchExpiresAt, now) : 0,
    canRetry: request.status === 'expired' && (request.attempt || 1) < MAX_ATTEMPTS,
    payment: paymentView(request),
    createdAt: request.createdAt,
    completedAt: request.completedAt || null,
  };
}

module.exports = { customerView, summaryView, paymentView, stageOf };
