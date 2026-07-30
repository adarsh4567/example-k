const ServiceRequest = require('../models/ServiceRequest');
const { ok, fail } = require('../utils/response');
const { isValidPhone } = require('../utils/validators');
const { isValidCategory, isValidSubcategory } = require('../services/serviceCatalog');
const { computePriceBreakdown } = require('../services/pricingService');
const dispatch = require('../services/dispatchService');
const { customerView } = require('../utils/requestPayload');

/**
 * LEGACY unauthenticated request endpoints, kept for test scripts and for driving
 * dispatch by hand from a REST client. They predate the customer app having
 * accounts, so they take the customer's name and phone in the body and leave
 * `user` null on the row.
 *
 * The real customer app uses /api/user/service-requests (see
 * userServiceRequestController), which is account-scoped and additionally
 * supports retry and payment. A request created here has no owner, so it is
 * invisible to those endpoints and gets no live customer push — dispatch to
 * workers, acceptance and completion all behave identically.
 */

const JOB_DESCRIPTION_MAX_LENGTH = 500;

function validCoord(lat, lng) {
  return (
    typeof lat === 'number' && typeof lng === 'number' &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
  );
}

// POST /api/service-requests
// { customerName, customerPhone, category, subcategory?, jobDescription, lat, lng, address?, radiusKm? }
async function createRequest(req, res, next) {
  try {
    const { customerName, customerPhone, category, subcategory, jobDescription, lat, lng, address, radiusKm } = req.body;

    if (!customerName || !customerName.trim()) return fail(res, 'customerName is required', 422);
    if (!isValidPhone(customerPhone)) return fail(res, 'A valid 10-digit customerPhone is required', 422);
    if (!isValidCategory(category)) return fail(res, `Invalid service category: ${category}`, 422);
    if (subcategory && !isValidSubcategory(category, subcategory)) {
      return fail(res, `Invalid subcategory "${subcategory}" for category "${category}"`, 422);
    }
    if (!jobDescription || !jobDescription.trim()) return fail(res, 'jobDescription is required', 422);
    if (jobDescription.trim().length > JOB_DESCRIPTION_MAX_LENGTH) {
      return fail(res, `jobDescription must be under ${JOB_DESCRIPTION_MAX_LENGTH} characters`, 422);
    }
    if (!validCoord(Number(lat), Number(lng))) {
      return fail(res, 'Valid numeric lat and lng are required', 422);
    }

    const request = new ServiceRequest({
      customer: { name: customerName.trim(), phone: String(customerPhone) },
      category,
      subcategory: subcategory || null,
      jobDescription: jobDescription.trim(),
      // Dummy rate-card pricing + dummy customer rating (schema default) — no
      // real pricing engine or customer-rating system yet.
      pricing: computePriceBreakdown(category),
      location: { type: 'Point', coordinates: [Number(lng), Number(lat)] },
      address: address || '',
      status: 'searching',
    });
    if (radiusKm) request.initialRadiusKm = Number(radiusKm);
    await request.save();

    // Kick off the first dispatch wave immediately.
    const offered = await dispatch.startDispatch(request);

    return ok(
      res,
      {
        request: await customerView(request),
        workersNotified: offered,
      },
      offered > 0
        ? `Request created — notified ${offered} nearby worker(s). Waiting for someone to accept.`
        : 'Request created — no workers in range yet. Search radius will expand automatically.',
      201
    );
  } catch (err) {
    next(err);
  }
}

// GET /api/service-requests/:id  — customer polls this for live status
async function getRequest(req, res, next) {
  try {
    const request = await ServiceRequest.findById(req.params.id);
    if (!request) return fail(res, 'Request not found', 404);
    return ok(res, { request: await customerView(request) }, 'Request status');
  } catch (err) {
    next(err);
  }
}

// POST /api/service-requests/:id/cancel
async function cancelRequest(req, res, next) {
  try {
    const result = await dispatch.cancelRequest(req.params.id);
    if (!result.ok) return fail(res, result.reason, result.code || 400);
    return ok(res, { request: await customerView(result.request) }, 'Request cancelled');
  } catch (err) {
    next(err);
  }
}

module.exports = { createRequest, getRequest, cancelRequest };
