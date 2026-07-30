const Worker = require('../models/Worker');
const { categoryName, subcategoryName } = require('../services/serviceCatalog');
const { MAX_ATTEMPTS } = require('../config/dispatchConfig');
const { PAYABLE_JOB_STATUS } = require('../services/paymentService');

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
        distanceKm: acceptedOffer ? acceptedOffer.distanceKm : null,
        location: worker.currentLocation || null,
      };
    }
    base.acceptedAt = request.acceptedAt;
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

module.exports = { customerView, summaryView, paymentView };
