// Shared serializers for service requests, used by both the REST controllers
// and the real-time socket layer so a worker sees identical shapes either way.

// Pending offer shown to a worker. Customer phone is hidden until acceptance.
function offerView(request, workerId) {
  const offer = (request.offers || []).find((o) => String(o.worker) === String(workerId));
  return {
    id: request._id,
    category: request.category,
    subcategory: request.subcategory,
    address: request.address, // approximate area shown pre-accept
    distanceKm: offer ? offer.distanceKm : null,
    customerName: request.customer.name,
    status: request.status,
    offeredAt: offer ? offer.offeredAt : null,
    wave: offer ? offer.wave : null,
  };
}

// Full view of a job assigned to the worker (reveals customer contact).
function assignedView(request) {
  return {
    id: request._id,
    status: request.status,
    category: request.category,
    subcategory: request.subcategory,
    address: request.address,
    location: request.location,
    customer: { name: request.customer.name, phone: request.customer.phone },
    acceptedAt: request.acceptedAt,
    completedAt: request.completedAt,
  };
}

module.exports = { offerView, assignedView };
