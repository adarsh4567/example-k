/**
 * Settling an approved trial into the worker's dashboard.
 *
 * The whole earnings/wallet/history stack is derived from completed
 * ServiceRequest documents (see earningsService + jobsController.myJobs).
 * A trial lives in its own TrialJob collection, so to make it show up
 * everywhere — wallet balance, weekly/monthly earnings, the day breakdown,
 * job history, "recent transactions" — we materialise the approved trial as a
 * single completed ServiceRequest and bump the profile-card counter.
 *
 * One code path, and every dashboard surface updates consistently, with no
 * changes to the earnings or jobs code. Idempotent via TrialJob.settledAt so a
 * re-run (e.g. engine auto-approve then an admin action) can't double-credit.
 */

const ServiceRequest = require('../models/ServiceRequest');

async function settleApprovedTrial(job, worker) {
  if (job.settledAt) {
    return { credited: false, alreadySettled: true, serviceRequestId: job.settledServiceRequest };
  }

  const p = job.pricing || {};
  const completedAt = job.completedAt || new Date();
  const coords = (job.location && job.location.coordinates) || [0, 0];

  // Materialise the trial as a finished job the earnings/history pipeline reads.
  const sr = await ServiceRequest.create({
    customer: { name: (job.host && job.host.name) || 'Trial host', phone: (job.host && job.host.phone) || '' },
    category: job.category,
    subcategory: job.subcategory || null,
    jobDescription: job.jobDescription,
    // Only the five fields ServiceRequest.pricing defines (trial-specific extras dropped).
    pricing: {
      currency: p.currency,
      totalPrice: p.totalPrice,
      platformFeePercent: p.platformFeePercent,
      platformFee: p.platformFee,
      workerEarning: p.workerEarning,
    },
    location: { type: 'Point', coordinates: coords },
    address: job.address || '',
    status: 'completed',
    acceptedBy: worker._id,
    acceptedAt: job.acceptedAt || completedAt,
    workDoneAt: completedAt,
    completedAt, // earnings buckets by completedAt → lands in the right week/month
    jobRating: null,
    notes: 'Trial job (onboarding)',
  });

  // Mark settled first so a concurrent/re-entrant call can't create a second SR.
  job.settledAt = new Date();
  job.settledServiceRequest = sr._id;
  await job.save();

  // Profile-card counter ("N jobs done"), mirroring what normal jobs do on rating.
  worker.jobsCompleted = (worker.jobsCompleted || 0) + 1;
  await worker.save();

  return { credited: true, serviceRequestId: sr._id, workerEarning: p.workerEarning };
}

module.exports = { settleApprovedTrial };
