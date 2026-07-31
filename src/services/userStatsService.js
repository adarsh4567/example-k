const mongoose = require('mongoose');
const ServiceRequest = require('../models/ServiceRequest');
const TrialJob = require('../models/TrialJob');

/**
 * The three numbers on the Account hero card: jobs done, credits, lifetime spend.
 *
 * The app used to derive all three from device-local booking history, which made
 * them wrong in two directions at once: a reinstall reset them to zero, and they
 * only ever counted scheduled bookings — a customer with ten instant jobs saw
 * "0 jobs done". Counting server-side is the only version that survives a new
 * phone and sees every booking type.
 *
 * A customer books through TWO collections — ServiceRequest (instant, dispatched)
 * and TrialJob (the discounted onboarding trial they book themselves) — so every
 * figure here is the sum of both.
 *
 * There is deliberately NO double counting of trials, and it is worth knowing why
 * rather than rediscovering it: trialSettlementService materialises an approved
 * trial as a completed ServiceRequest so it reaches the worker's earnings and
 * history. That synthetic row is worker-facing and carries no `user`, so it never
 * matches the customer queries below. If that ever changes, this file starts
 * counting trials twice — the settled row would need excluding by
 * `settledServiceRequest`.
 *
 * Money comes from `payment.amount` (snapshotted at capture), never
 * `pricing.totalPrice` — a rate-card change must not retroactively alter what a
 * customer is told they have spent.
 */

// From the customer's point of view the job is done the moment the professional
// marks the on-site work finished. `completed` additionally requires the WORKER
// to submit their rating (see ServiceRequest's status notes) — waiting on that
// tap would make the customer's own counter lag for a reason they can't see or
// fix, so both count. This matches what the app's local history did.
const DONE_STATUSES = ['pending_rating', 'completed'];

const oid = (id) => new mongoose.Types.ObjectId(String(id));

// One pass per collection: the counters are conditional sums rather than
// separate queries, so the whole stat block is two indexed aggregations.
function statPipeline(match) {
  return [
    { $match: match },
    {
      $group: {
        _id: null,
        jobsCompleted: {
          $sum: { $cond: [{ $in: ['$status', DONE_STATUSES] }, 1, 0] },
        },
        lifetimeSpend: {
          $sum: {
            $cond: [{ $eq: ['$payment.status', 'paid'] }, { $ifNull: ['$payment.amount', 0] }, 0],
          },
        },
        paidBookings: {
          $sum: { $cond: [{ $eq: ['$payment.status', 'paid'] }, 1, 0] },
        },
      },
    },
  ];
}

const EMPTY = { jobsCompleted: 0, lifetimeSpend: 0, paidBookings: 0 };

/**
 * @returns {Promise<{jobsCompleted:number, lifetimeSpend:number, paidBookings:number}>}
 *
 * `paidBookings` is not shown anywhere — it's the "has this customer ever paid
 * for anything" signal behind first-booking coupon eligibility and referral
 * maturity, and it comes free with the aggregation the hero card already needs.
 */
async function getUserStats(userId) {
  const id = oid(userId);
  const [requests, trials] = await Promise.all([
    ServiceRequest.aggregate(statPipeline({ user: id })),
    TrialJob.aggregate(statPipeline({ requestedBy: id })),
  ]);

  const a = requests[0] || EMPTY;
  const b = trials[0] || EMPTY;

  return {
    jobsCompleted: a.jobsCompleted + b.jobsCompleted,
    lifetimeSpend: a.lifetimeSpend + b.lifetimeSpend,
    paidBookings: a.paidBookings + b.paidBookings,
  };
}

module.exports = { getUserStats, DONE_STATUSES };
