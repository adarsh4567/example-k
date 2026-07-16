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

// Full view of a job assigned to the worker (reveals customer contact).
// `jobRating` is the worker's own 1-5 rating for this job — null until they
// submit it (status pending_rating), then shown on every completed job in history.
function assignedView(request) {
  return {
    id: request._id,
    status: request.status,
    category: request.category,
    subcategory: request.subcategory,
    jobDescription: request.jobDescription,
    address: request.address,
    location: request.location,
    customer: { name: request.customer.name, phone: request.customer.phone },
    customerRating: request.customerRating,
    pricing: request.pricing,
    jobRating: request.jobRating,
    acceptedAt: request.acceptedAt,
    workDoneAt: request.workDoneAt,
    completedAt: request.completedAt,
  };
}

module.exports = { offerView, assignedView };
