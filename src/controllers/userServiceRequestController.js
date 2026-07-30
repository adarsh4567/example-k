const ServiceRequest = require('../models/ServiceRequest');
const { ok, fail } = require('../utils/response');
const { isValidCategory, isValidSubcategory } = require('../services/serviceCatalog');
const { computePriceBreakdown } = require('../services/pricingService');
const dispatch = require('../services/dispatchService');
const paymentService = require('../services/paymentService');
const emitter = require('../realtime/emitter');
const { customerView, summaryView } = require('../utils/requestPayload');
const { MAX_ATTEMPTS, SEARCH_WINDOW_SECONDS } = require('../config/dispatchConfig');

/**
 * The customer app's end-to-end service flow, all behind a user JWT.
 *
 *   raise ──▶ searching (1 min) ──▶ accepted ──▶ work done ──▶ pay ──▶ closed
 *                   │
 *                   └─▶ expired ──▶ retry (same request id, new attempt)
 *
 * This is the authenticated counterpart to serviceRequestController, which keeps
 * serving the older unauthenticated endpoints for test scripts. The split is
 * deliberate rather than a flag on one controller: everything here is scoped to
 * `req.user`, and ownership is the precondition for every single route, so the
 * scoping lives in one middleware instead of being re-checked per handler.
 */

const JOB_DESCRIPTION_MAX_LENGTH = 500;

// Statuses that mean "this customer already has something on the go".
const OPEN_STATUSES = ServiceRequest.OPEN_STATUSES;

function validCoord(lat, lng) {
  return (
    typeof lat === 'number' && typeof lng === 'number' &&
    !Number.isNaN(lat) && !Number.isNaN(lng) &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
  );
}

/**
 * Route middleware: load the request and prove this customer owns it.
 *
 * A request belonging to someone else answers 404, not 403 — a 403 would confirm
 * that the id exists, letting anyone with a token enumerate other people's
 * request ids. From this customer's perspective it genuinely does not exist.
 */
async function loadOwnedRequest(req, res, next) {
  try {
    const request = await ServiceRequest.findById(req.params.id);
    if (!request || String(request.user || '') !== String(req.user._id)) {
      return fail(res, 'Request not found', 404);
    }
    req.serviceRequest = request;
    next();
  } catch (err) {
    // A malformed ObjectId lands here; it's a bad id, not a server fault.
    if (err.name === 'CastError') return fail(res, 'Request not found', 404);
    next(err);
  }
}

/**
 * POST /api/user/service-requests
 * { category, subcategory?, jobDescription, lat, lng, address?, radiusKm? }
 *
 * The customer's name and phone are NOT accepted from the body — they're taken
 * from the authenticated account. Trusting the body would let one account raise
 * requests under another person's contact details, and the worker sees that
 * contact on acceptance.
 */
async function createRequest(req, res, next) {
  try {
    const user = req.user;
    const { category, subcategory, jobDescription, lat, lng, address, radiusKm } = req.body || {};

    // The worker is shown the customer's name before deciding whether to accept,
    // so a nameless account can't raise a request. `profileCompleted` on the auth
    // response is the same signal — the app should have collected this already.
    if (!user.fullName || !user.fullName.trim()) {
      return fail(res, 'Please add your name to your profile before booking a service', 422, {
        code: 'PROFILE_INCOMPLETE',
      });
    }

    if (!isValidCategory(category)) return fail(res, `Invalid service category: ${category}`, 422);
    if (subcategory && !isValidSubcategory(category, subcategory)) {
      return fail(res, `Invalid subcategory "${subcategory}" for category "${category}"`, 422);
    }
    if (!jobDescription || !String(jobDescription).trim()) return fail(res, 'jobDescription is required', 422);
    if (String(jobDescription).trim().length > JOB_DESCRIPTION_MAX_LENGTH) {
      return fail(res, `jobDescription must be under ${JOB_DESCRIPTION_MAX_LENGTH} characters`, 422);
    }
    if (!validCoord(Number(lat), Number(lng))) {
      return fail(res, 'Valid numeric lat and lng are required', 422);
    }

    // One live request per customer. Without this, a customer who double-tapped
    // "Book" would put two searches over the same job into the field and could
    // end up with two workers arriving — and dispatch has no notion of merging
    // them. The existing request comes back in the 409 so the app can just show
    // it instead of surfacing an error the customer can't act on.
    const existing = await ServiceRequest.findOne({ user: user._id, status: { $in: OPEN_STATUSES } });
    if (existing) {
      return fail(res, 'You already have a service request in progress', 409, {
        code: 'REQUEST_IN_PROGRESS',
        request: await customerView(existing),
      });
    }

    const request = new ServiceRequest({
      user: user._id,
      customer: { name: user.fullName.trim(), phone: user.phone },
      category,
      subcategory: subcategory || null,
      jobDescription: String(jobDescription).trim(),
      // Dummy rate-card pricing + dummy customer rating (schema default) — no
      // real pricing engine or customer-rating system yet.
      pricing: computePriceBreakdown(category),
      location: { type: 'Point', coordinates: [Number(lng), Number(lat)] },
      address: address || '',
      status: 'searching',
    });
    if (radiusKm) request.initialRadiusKm = Number(radiusKm);
    await request.save();

    // Kick off the first dispatch wave immediately, and start the customer's clock.
    const offered = await dispatch.startDispatch(request);

    return ok(
      res,
      {
        request: await customerView(request),
        workersNotified: offered,
        searchWindowSeconds: SEARCH_WINDOW_SECONDS,
      },
      offered > 0
        ? `Looking for a professional — ${offered} nearby worker(s) notified.`
        : 'Looking for a professional — none in range yet, the search area will widen automatically.',
      201
    );
  } catch (err) {
    next(err);
  }
}

// GET /api/user/service-requests  — the customer's own requests, newest first.
// Split into `active` and `history` so the home screen doesn't have to sort or
// classify statuses itself.
async function listRequests(req, res, next) {
  try {
    const requests = await ServiceRequest.find({ user: req.user._id })
      .sort({ createdAt: -1 })
      .limit(50);

    const active = requests.filter((r) => OPEN_STATUSES.includes(r.status));
    const history = requests.filter((r) => !OPEN_STATUSES.includes(r.status));

    return ok(
      res,
      {
        // The active list gets the full view (it's at most a handful of rows and
        // the screen needs the worker card); history gets summaries to keep one
        // list request from fanning out into 50 worker lookups.
        active: await Promise.all(active.map((r) => customerView(r))),
        history: history.map(summaryView),
      },
      'Your service requests'
    );
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/user/service-requests/active
 *
 * What the app calls on launch to work out which screen to show. Returns the one
 * live request (or null), including finished-but-unpaid work — the payment card
 * is still actionable and is the easiest thing for a customer to lose track of
 * after closing the app.
 */
async function activeRequest(req, res, next) {
  try {
    const request = await ServiceRequest.findOne(
      ServiceRequest.liveForUserQuery(req.user._id)
    ).sort({ createdAt: -1 });

    return ok(
      res,
      { request: request ? await customerView(request) : null },
      request ? 'Active request' : 'No active request'
    );
  } catch (err) {
    next(err);
  }
}

// GET /api/user/service-requests/:id  — poll this if you aren't on the socket.
async function getRequest(req, res, next) {
  try {
    return ok(res, { request: await customerView(req.serviceRequest) }, 'Request status');
  } catch (err) {
    next(err);
  }
}

// POST /api/user/service-requests/:id/cancel
async function cancelRequest(req, res, next) {
  try {
    const result = await dispatch.cancelRequest(req.serviceRequest._id);
    if (!result.ok) return fail(res, result.reason, result.code || 400);
    return ok(res, { request: await customerView(result.request) }, 'Request cancelled');
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/user/service-requests/:id/retry
 *
 * Search again on the SAME request after the timer ran out with no acceptance.
 * The id is stable across retries, so the app keeps its socket subscription and
 * its open screen; only `attempt` and the countdown reset.
 */
async function retryRequest(req, res, next) {
  try {
    const result = await dispatch.retryRequest(req.serviceRequest._id);
    if (!result.ok) {
      return fail(res, result.reason, result.code || 400, {
        // 429 here means the attempt cap is spent, and the app's next move is to
        // raise a fresh request rather than to keep retrying this one.
        code: result.code === 429 ? 'RETRY_LIMIT_REACHED' : undefined,
        maxAttempts: MAX_ATTEMPTS,
      });
    }
    return ok(
      res,
      {
        request: await customerView(result.request),
        workersNotified: result.offered,
        attempt: result.attempt,
        maxAttempts: MAX_ATTEMPTS,
        searchWindowSeconds: SEARCH_WINDOW_SECONDS,
      },
      result.offered > 0
        ? `Searching again — ${result.offered} nearby worker(s) notified (attempt ${result.attempt} of ${MAX_ATTEMPTS}).`
        : `Searching again (attempt ${result.attempt} of ${MAX_ATTEMPTS}) — none in range yet.`
    );
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/user/service-requests/:id/payment/initiate   { method }
 *
 * Opens a payment and returns the `orderId` to hand to the gateway SDK. In mock
 * mode there is no SDK — go straight to confirm with this orderId.
 */
async function initiatePayment(req, res, next) {
  try {
    const { method } = req.body || {};
    const result = await paymentService.initiatePayment(req.serviceRequest, { method });
    if (!result.ok) return fail(res, result.reason, result.code || 400);

    const request = await customerView(result.request);
    if (result.alreadyPaid) return ok(res, { request }, 'This job is already paid');

    return ok(
      res,
      {
        request,
        payment: {
          orderId: result.payment.orderId,
          amount: result.payment.amount,
          currency: result.payment.currency,
          method: result.payment.method,
          provider: result.payment.provider,
          mode: paymentService.MODE,
        },
      },
      'Payment initiated'
    );
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/user/service-requests/:id/payment/confirm  { orderId, gatewayReference? }
 *
 * Captures the payment and credits the worker in the same call. Safe to retry:
 * confirming an already-paid job returns success without paying anyone twice.
 */
async function confirmPayment(req, res, next) {
  try {
    const { orderId, gatewayReference } = req.body || {};
    const result = await paymentService.confirmPayment(req.serviceRequest, { orderId, gatewayReference });

    if (!result.ok) {
      // 402 = the gateway declined. The request is left at payment `failed`, so
      // the app can call initiate again on the same request.
      return fail(res, result.reason, result.code || 400, {
        request: result.request ? await customerView(result.request) : undefined,
      });
    }

    const request = await customerView(result.request);
    // Real-time: mirror the outcome onto the customer's other devices, and keep
    // the socket transcript complete for anything replaying the event stream.
    emitter.emitToUser(result.request.user, 'request:paid', { request });

    return ok(
      res,
      { request, workerCredited: result.credited },
      result.alreadyPaid ? 'This job is already paid' : 'Payment successful — the professional has been credited'
    );
  } catch (err) {
    next(err);
  }
}

module.exports = {
  loadOwnedRequest,
  createRequest,
  listRequests,
  activeRequest,
  getRequest,
  cancelRequest,
  retryRequest,
  initiatePayment,
  confirmPayment,
};
