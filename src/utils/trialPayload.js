// Serializers for trial jobs, mirroring utils/jobPayload.js so the worker app
// sees consistent shapes. The host's phone is hidden pre-accept (same rule as a
// normal job's customer contact) and revealed once the worker accepts.

// View shown to the WORKER. `revealContact` becomes true after acceptance.
function trialWorkerView(job) {
  const revealContact = ['accepted', 'in_progress', 'completed'].includes(job.status);
  return {
    id: job._id,
    type: 'trial',
    status: job.status,
    category: job.category,
    subcategory: job.subcategory,
    jobDescription: job.jobDescription,
    scheduledTime: job.scheduledTime,
    address: job.address,
    location: job.location,
    host: {
      name: job.host && job.host.name,
      phone: revealContact ? job.host && job.host.phone : undefined,
    },
    pricing: job.pricing,
    offerExpiresAt: job.offerExpiresAt,
    acceptedAt: job.acceptedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
  };
}

// Full view for the ADMIN panel — includes checkout + feedback.
function trialAdminView(job) {
  return {
    id: job._id,
    worker: job.worker,
    status: job.status,
    category: job.category,
    subcategory: job.subcategory,
    jobDescription: job.jobDescription,
    scheduledTime: job.scheduledTime,
    host: job.host,
    address: job.address,
    location: job.location,
    pricing: job.pricing,
    offerExpiresAt: job.offerExpiresAt,
    acceptedAt: job.acceptedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    declinedAt: job.declinedAt,
    declinedReason: job.declinedReason,
    checkout: job.checkout,
    feedback: job.feedback,
    createdAt: job.createdAt,
  };
}

module.exports = { trialWorkerView, trialAdminView };
