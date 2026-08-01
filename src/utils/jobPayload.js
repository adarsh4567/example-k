// Shared serializers for service requests, used by both the REST controllers
// and the real-time socket layer so a worker sees identical shapes either way.

// Pending offer shown to a worker. Customer phone is hidden until acceptance.
// Includes the price breakdown + job description + customer rating so the
// worker can decide whether to accept.
function offerView(request, workerId) {
  const offer = (request.offers || []).find((o) => String(o.worker) === String(workerId));
  return {
    id: request._id,
    category: request.category,
    subcategory: request.subcategory,
    jobDescription: request.jobDescription,
    address: request.address, // approximate area shown pre-accept
    distanceKm: offer ? offer.distanceKm : null,
    customerName: request.customer.name,
    customerRating: request.customerRating,
    pricing: request.pricing,
    status: request.status,
    offeredAt: offer ? offer.offeredAt : null,
    wave: offer ? offer.wave : null,
  };
}

/**
 * Full view of a job assigned to the worker (reveals customer contact).
 *
 * `jobRating` is the worker's own 1-5 rating for this job — null until they
 * submit it (status pending_rating), then shown on every completed job in history.
 *
 * `workStage` and the `can*` flags are what the app's primary button switches
 * on. They are shipped rather than derived client-side for the same reason the
 * customer's view ships `canRetry` and `payment.payable`: which action is legal
 * next is a decision the server enforces anyway, and a client re-implementing
 * the matrix drifts out of sync the moment either side changes. Before this the
 * app had nothing but `status` to go on, which is why accepting a job put a
 * "Mark as completed" button on screen while the worker was still driving.
 */
function assignedView(request) {
  const stage = request.workStage || 'en_route';
  const t = request.tracking || {};
  const inProgress = request.status === 'in_progress';
  return {
    id: request._id,
    status: request.status,
    // 'en_route' | 'working'. Only meaningful while status === 'in_progress'.
    workStage: stage,
    category: request.category,
    subcategory: request.subcategory,
    jobDescription: request.jobDescription,
    address: request.address,
    location: request.location,
    customer: { name: request.customer.name, phone: request.customer.phone },
    customerRating: request.customerRating,
    pricing: request.pricing,
    jobRating: request.jobRating,

    // ── What the worker may do right now ──
    // shouldSendLocation is the app's cue to start/stop its GPS ticker; when it
    // is false, POST /:id/location will refuse the ping anyway.
    shouldSendLocation: inProgress && stage === 'en_route',
    canStart: inProgress && stage === 'en_route',
    canComplete: inProgress && stage === 'working',
    canRate: request.status === 'pending_rating',

    // The server's own read on how close the worker is — the same verdict the
    // customer is seeing, so the two apps can't tell different stories.
    arrivalStatus: t.arrivalStatus || 'en_route',
    distanceMeters: t.distanceMeters ?? null,
    etaMinutes: t.etaMinutes ?? null,

    acceptedAt: request.acceptedAt,
    workStartedAt: request.workStartedAt || null,
    workDoneAt: request.workDoneAt,
    completedAt: request.completedAt,
  };
}

module.exports = { offerView, assignedView };
