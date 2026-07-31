const mongoose = require('mongoose');
const TrialJob = require('../models/TrialJob');
const Worker = require('../models/Worker');
const UserWalletTransaction = require('../models/UserWalletTransaction');
const gateway = require('./paymentGateway');
const { computeTrialPrice, CURRENCY } = require('./pricingService');
const { transitionWorker } = require('./workerStatusService');
const { notifyWorker } = require('./notificationService');
const referral = require('./referralService');
const emitter = require('../realtime/emitter');
const {
  TRIAL_ENABLED,
  USER_TRIAL_ENABLED,
  USER_TRIAL_CATEGORY,
  USER_TRIAL_MAX_CANDIDATES,
  USER_TRIAL_SEARCH_RADIUS_KM,
  USER_TRIAL_MAX_PER_USER,
  OFFER_WINDOW_SECONDS,
} = require('../config/trialConfig');

/**
 * Customer-booked trial jobs.
 *
 * A trial job exists to get a trainee worker through the last onboarding filter.
 * Until now only ops could create one (they typed in a host's details and picked a
 * worker by hand). This lets a customer book one themselves at a discounted price,
 * which turns a manual ops task into supply the platform can actually clear.
 *
 * ── Why a candidate QUEUE and not a broadcast ────────────────────
 * Normal jobs are broadcast to every nearby worker and the first to accept wins.
 * A trial cannot work that way: accepting a trial moves the worker's application
 * status to `trial_assigned`, and there is exactly one trial per worker. Offering
 * to ten workers would mean ten status transitions, nine of which have to be
 * rolled back — and a worker briefly told they had a trial when they didn't.
 *
 * So the offer is DIRECTED, one worker at a time, in order of distance. If a
 * candidate declines or lets the countdown lapse, the offer rolls to the next.
 * That keeps the TrialJob lifecycle byte-identical to the admin-assigned one,
 * which is why the worker app needed no changes at all: it still sees a single
 * `trial:assigned` offer with a countdown, and never learns it was one of three.
 *
 * ── Where the money goes ─────────────────────────────────────────
 * With default pricing: base ₹110, the customer pays ₹100, the worker keeps the
 * FULL ₹100 (no commission on a trial), and ₹40 is credited back to the customer
 * as a reward. The platform is ₹40 out of pocket per trial — that is the
 * customer-acquisition spend, and it is the reason the promo is capped per account.
 *
 * The customer's payment funds the reward immediately; the WORKER's ₹100 is paid
 * through the existing approval-time settlement (trialSettlementService), not
 * from here. Those are separate on purpose: a trial only pays out if it is
 * approved, and that policy predates this flow.
 */

const CANDIDATE_TERMINAL = ['declined', 'expired', 'skipped'];

function validCoord(lat, lng) {
  return (
    typeof lat === 'number' && typeof lng === 'number' &&
    !Number.isNaN(lat) && !Number.isNaN(lng) &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
  );
}

// ── Eligibility ──────────────────────────────────────────────────

/**
 * Can this customer book a discounted trial right now?
 * @returns {Promise<{eligible:boolean, reason?:string, code?:string, used:number, allowance:number, liveJobId?:string}>}
 */
async function checkEligibility(user) {
  const allowance = USER_TRIAL_MAX_PER_USER;

  if (!TRIAL_ENABLED || !USER_TRIAL_ENABLED) {
    return { eligible: false, code: 'TRIAL_DISABLED', reason: 'Trial bookings are not available right now', used: 0, allowance };
  }

  // One booking needing attention at a time — the same double-tap guard as normal
  // requests, and here it also protects the worker: two live trials would mean two
  // trainees pulled out of the queue for one customer. A finished trial that is
  // both paid and rated does NOT block a new one.
  const live = await TrialJob.findOne(TrialJob.needsCustomerQuery(user._id)).sort({ createdAt: -1 });
  if (live) {
    return {
      eligible: false,
      code: 'TRIAL_IN_PROGRESS',
      reason: 'You already have a trial booking in progress',
      used: 0,
      allowance,
      liveJobId: String(live._id),
    };
  }

  // Lifetime cap. Counts only bookings a worker actually took on — a booking
  // nobody accepted gave the customer no service, so it must not burn their one
  // discounted trial.
  const used = await TrialJob.countDocuments({
    requestedBy: user._id,
    status: { $in: TrialJob.ALLOWANCE_STATUSES },
  });
  if (used >= allowance) {
    return {
      eligible: false,
      code: 'TRIAL_ALLOWANCE_USED',
      reason:
        allowance === 1
          ? 'You have already used your discounted trial booking'
          : `You have used all ${allowance} of your discounted trial bookings`,
      used,
      allowance,
    };
  }

  return { eligible: true, used, allowance };
}

// ── Candidate search ─────────────────────────────────────────────

/**
 * The nearest workers waiting for their onboarding trial who could take this job.
 *
 * Two radius constraints, exactly as live dispatch applies them: our outer search
 * bound, and the worker's OWN declared travel radius from onboarding — a worker
 * who said "2 km" is never offered a job 5 km away.
 *
 * Cleaning only. Electricians never reach `pending_trial` at all (they do the
 * in-person shop assessment instead), but other trades do, so the category filter
 * is explicit rather than relying on that.
 */
async function findCandidates(lat, lng, { limit = USER_TRIAL_MAX_CANDIDATES, exclude = [] } = {}) {
  const categoryMatch = {
    $or: [
      { 'work.primaryCategory': USER_TRIAL_CATEGORY },
      // Documents created before `primaryCategory` existed are cleaning by
      // definition. ({ field: null } matches an explicit null AND a missing field.)
      ...(USER_TRIAL_CATEGORY === 'cleaning' ? [{ 'work.primaryCategory': null }] : []),
    ],
  };

  const results = await Worker.aggregate([
    {
      $geoNear: {
        near: { type: 'Point', coordinates: [lng, lat] },
        distanceField: 'distanceMeters',
        maxDistance: USER_TRIAL_SEARCH_RADIUS_KM * 1000,
        spherical: true,
        query: {
          status: 'pending_trial',
          _id: { $nin: exclude.map((id) => new mongoose.Types.ObjectId(String(id))) },
          ...categoryMatch,
        },
      },
    },
    {
      $match: {
        $expr: {
          $lte: [
            '$distanceMeters',
            { $multiply: [{ $ifNull: ['$location.travelRadiusKm', USER_TRIAL_SEARCH_RADIUS_KM] }, 1000] },
          ],
        },
      },
    },
    { $limit: limit },
    { $project: { _id: 1, fullName: 1, phone: 1, distanceMeters: 1 } },
  ]);

  return results.map((w, i) => ({
    worker: w._id,
    fullName: w.fullName,
    phone: w.phone,
    distanceKm: Math.round((w.distanceMeters / 1000) * 100) / 100,
    order: i,
  }));
}

// ── Pushing state to the customer ────────────────────────────────

// Best-effort: a socket failure must never roll back a decision already
// persisted. The customer's polling GET is the safety net.
async function pushToCustomer(job, event, extra = {}) {
  if (!job.requestedBy) return;
  try {
    const { trialUserView } = require('../utils/trialPayload');
    emitter.emitToUser(job.requestedBy, event, { trial: await trialUserView(job), ...extra });
  } catch (err) {
    console.error(`[user-trial] customer push failed (${event}) for job ${job._id}:`, err.message);
  }
}

// ── Offering ─────────────────────────────────────────────────────

/**
 * Offer the job to `candidates[index]` and start their countdown.
 *
 * The socket payload and the worker status transition are deliberately identical
 * to what admin assignment produces — same event name, same fields — so the
 * worker app cannot tell a customer-booked trial from an ops-assigned one.
 *
 * Mutates + saves `job`.
 */
async function offerToCandidate(job, index) {
  const candidate = job.candidates[index];
  if (!candidate) return { ok: false, reason: 'No such candidate' };

  const worker = await Worker.findById(candidate.worker);
  // The queue was built from a snapshot; by the time we get here a worker may
  // have been assigned another trial or moved on. Skip them rather than fail.
  if (!worker || worker.status !== 'pending_trial') {
    candidate.status = 'skipped';
    candidate.closedAt = new Date();
    return { ok: false, skipped: true, reason: 'Candidate no longer awaiting a trial' };
  }

  const now = new Date();
  job.worker = worker._id;
  job.candidateIndex = index;
  job.status = 'assigned';
  job.offerExpiresAt = new Date(now.getTime() + OFFER_WINDOW_SECONDS * 1000);
  // A fresh offer clears the previous one's terminal fields, so a job that rolled
  // past a decline doesn't keep reporting itself as declined.
  job.declinedAt = undefined;
  job.declinedReason = null;
  candidate.status = 'offered';
  candidate.offeredAt = now;
  await job.save();

  await transitionWorker(worker, 'trial_assigned', {
    reason: 'Trial job booked by customer',
    trialJob: job._id,
  });

  const [lng, lat] = (job.location && job.location.coordinates) || [0, 0];
  emitter.emitToWorker(worker._id, 'trial:assigned', {
    jobId: String(job._id),
    host: { name: job.host.name, address: job.address, lat, lng },
    scheduledTime: job.scheduledTime,
    rate: job.pricing,
    offerExpiresAt: job.offerExpiresAt,
  });
  await notifyWorker(worker, {
    title: 'New trial job offer 🧪',
    message: `A trial ${job.category} job is available. Open the app to accept before it expires.`,
  }).catch(() => {});

  console.log(
    `🧪 [user-trial] offered job ${job._id} to worker ${worker._id} ` +
      `(candidate ${index + 1}/${job.candidates.length}, ${candidate.distanceKm}km)`
  );

  return { ok: true, worker, candidate };
}

/**
 * Walk to the next candidate after the current one declines or times out.
 *
 * Called from the worker's decline handler and from the offer-expiry sweeper. For
 * an admin-assigned trial (no candidates) it returns `{rolled:false}` and the
 * caller keeps its original behaviour — which is how this stayed backwards
 * compatible with the ops flow.
 *
 * @param {Document} job
 * @param {'worker_declined'|'timeout'} reason
 * @returns {Promise<{rolled:boolean, exhausted?:boolean, job}>}
 */
async function rollToNextCandidate(job, reason) {
  if (job.source !== 'user' || !job.candidates.length) return { rolled: false, job };

  const closedIndex = job.candidateIndex;
  const current = job.candidates[closedIndex];
  if (current && !CANDIDATE_TERMINAL.includes(current.status)) {
    current.status = reason === 'timeout' ? 'expired' : 'declined';
    current.closedAt = new Date();
  }

  // Whole-search deadline still governs: don't start a new countdown that would
  // outlive the window the customer is watching.
  const windowSpent = job.searchExpiresAt && new Date(job.searchExpiresAt) <= new Date();

  if (!windowSpent) {
    for (let i = closedIndex + 1; i < job.candidates.length; i++) {
      const attempt = await offerToCandidate(job, i);
      if (attempt.ok) {
        await pushToCustomer(job, 'trial:searching', {
          candidateNumber: i + 1,
          candidateCount: job.candidates.length,
        });
        return { rolled: true, job };
      }
      // Skipped candidate — offerToCandidate marked it; try the next one.
    }
  }

  // Queue spent (or the window closed). This is where a user booking finally
  // becomes terminal, and the customer is offered a retry.
  job.candidateIndex = -1;
  job.status = reason === 'timeout' ? 'expired' : 'declined';
  job.declinedReason = reason;
  job.declinedAt = new Date();
  job.offerExpiresAt = undefined;
  await job.save();

  await pushToCustomer(job, 'trial:no_workers', { reason });
  console.log(`🧪 [user-trial] job ${job._id} exhausted its candidate queue (${reason})`);

  return { rolled: false, exhausted: true, job };
}

// ── Booking ──────────────────────────────────────────────────────

/**
 * Create a customer-booked trial and offer it to the nearest candidate.
 *
 * If no candidate is in range, NO row is created and the caller gets a 409. The
 * search is a single geo query, so we know instantly — persisting an ownerless
 * "searching" trial with no worker (a required field) would buy nothing and leave
 * rows to garbage-collect.
 *
 * @returns {{ok:true, job, candidateCount}} | {{ok:false, code, reason, httpCode}}
 */
async function createTrialBooking(user, { subcategory, jobDescription, lat, lng, address, scheduledTime }) {
  const category = USER_TRIAL_CATEGORY;

  const candidates = await findCandidates(Number(lat), Number(lng));
  if (!candidates.length) {
    return {
      ok: false,
      httpCode: 409,
      code: 'NO_TRIAL_WORKERS',
      reason:
        'No trainee professionals are waiting for a trial near you right now. ' +
        'Please try again later, or book a regular service.',
    };
  }

  const now = new Date();
  const pricing = computeTrialPrice(category);

  const job = new TrialJob({
    // `worker` is required, so it is set to the first candidate up front and then
    // kept in step with whoever holds the offer.
    worker: candidates[0].worker,
    source: 'user',
    requestedBy: user._id,
    host: { name: user.fullName.trim(), phone: user.phone },
    category,
    subcategory: subcategory || null,
    jobDescription: String(jobDescription).trim(),
    scheduledTime: scheduledTime ? new Date(scheduledTime) : null,
    location: { type: 'Point', coordinates: [Number(lng), Number(lat)] },
    address: address || '',
    pricing,
    status: 'assigned',
    candidates: candidates.map((c) => ({
      worker: c.worker,
      distanceKm: c.distanceKm,
      order: c.order,
      status: 'queued',
    })),
    candidateIndex: -1,
    // The whole-search window: every candidate gets a full turn, and the customer
    // is told a definite worst case up front.
    searchExpiresAt: new Date(now.getTime() + candidates.length * OFFER_WINDOW_SECONDS * 1000),
    payment: {
      status: 'not_due',
      amount: pricing.userPrice,
      currency: pricing.currency || CURRENCY,
    },
    reward: { amount: pricing.userReward, percent: pricing.userRewardPercent, creditedAt: null },
  });
  await job.save();

  // Offer to the nearest candidate that is still actually waiting.
  for (let i = 0; i < job.candidates.length; i++) {
    const attempt = await offerToCandidate(job, i);
    if (attempt.ok) {
      return { ok: true, job, candidateCount: job.candidates.length };
    }
  }

  // Every candidate went stale between the query and the offer — rare, but it
  // must not leave a live row nobody will ever act on.
  job.status = 'expired';
  job.declinedReason = 'timeout';
  job.declinedAt = new Date();
  job.candidateIndex = -1;
  await job.save();
  return {
    ok: false,
    httpCode: 409,
    code: 'NO_TRIAL_WORKERS',
    reason: 'The trainee professionals near you just became unavailable. Please try again in a moment.',
  };
}

/**
 * Retry a booking whose candidate queue was spent with nobody accepting.
 *
 * Rebuilds the queue from a fresh geo query — the point of retrying is that the
 * available supply has changed — and keeps the same job id so the customer app
 * holds its screen and subscription.
 */
async function retryTrialBooking(job) {
  if (!['declined', 'expired'].includes(job.status)) {
    return { ok: false, httpCode: 409, reason: `Cannot retry a trial in "${job.status}"` };
  }

  // Don't re-offer to anyone who already declined this exact booking; a timeout
  // is forgiven (they may simply have had their phone away), a decline is not.
  const declined = job.candidates.filter((c) => c.status === 'declined').map((c) => c.worker);
  const candidates = await findCandidates(
    job.location.coordinates[1],
    job.location.coordinates[0],
    { exclude: declined }
  );
  if (!candidates.length) {
    return {
      ok: false,
      httpCode: 409,
      code: 'NO_TRIAL_WORKERS',
      reason: 'Still no trainee professionals available near you. Please try again later.',
    };
  }

  const now = new Date();
  job.searchAttempt = (job.searchAttempt || 1) + 1;
  job.candidates = candidates.map((c) => ({
    worker: c.worker,
    distanceKm: c.distanceKm,
    order: c.order,
    status: 'queued',
  }));
  job.candidateIndex = -1;
  job.searchExpiresAt = new Date(now.getTime() + candidates.length * OFFER_WINDOW_SECONDS * 1000);
  await job.save();

  for (let i = 0; i < job.candidates.length; i++) {
    const attempt = await offerToCandidate(job, i);
    if (attempt.ok) return { ok: true, job, candidateCount: job.candidates.length };
  }

  job.status = 'expired';
  job.declinedReason = 'timeout';
  job.declinedAt = new Date();
  await job.save();
  return {
    ok: false,
    httpCode: 409,
    code: 'NO_TRIAL_WORKERS',
    reason: 'The trainee professionals near you just became unavailable. Please try again in a moment.',
  };
}

/** Customer cancels their booking. Frees whichever worker currently holds it. */
async function cancelTrialBooking(job) {
  // Once the work is done there is money and a pending onboarding decision
  // attached — cancelling would strip the worker of a trial they actually did.
  if (job.status === 'completed') {
    return {
      ok: false,
      httpCode: 409,
      reason: 'The work is already done — please pay and submit your feedback instead',
    };
  }
  if (!TrialJob.LIVE_STATUSES.includes(job.status)) {
    return { ok: false, httpCode: 409, reason: `This trial is already ${job.status}` };
  }

  const heldBy = job.worker;
  const current = job.candidates[job.candidateIndex];
  if (current && !CANDIDATE_TERMINAL.includes(current.status)) {
    current.status = 'skipped';
    current.closedAt = new Date();
  }
  // Terminal as 'declined' with an explicit reason — see the note on
  // declinedReason in the model for why there is no 'cancelled' job status.
  job.status = 'declined';
  job.declinedReason = 'customer_cancelled';
  job.declinedAt = new Date();
  job.candidateIndex = -1;
  job.offerExpiresAt = undefined;
  job.notes = 'Cancelled by customer';
  await job.save();

  // Put the worker back in the trial queue — they did nothing wrong, and leaving
  // them in `trial_assigned` would strand them out of the queue forever.
  const worker = await Worker.findById(heldBy);
  if (worker && ['trial_assigned', 'trial_accepted'].includes(worker.status)) {
    await transitionWorker(worker, 'pending_trial', {
      reason: 'Customer cancelled the trial booking',
      trialJob: job._id,
    });
    await notifyWorker(worker, {
      title: 'Trial booking cancelled',
      message: 'The customer cancelled that trial job. You are back in the queue for a new one.',
    }).catch(() => {});
  }

  await pushToCustomer(job, 'trial:cancelled');
  return { ok: true, job };
}

// ── Payment + reward ─────────────────────────────────────────────

// Payment is collectable once the work is done. Mirrors the normal flow's rule.
const isPayable = (job) => job.status === 'completed';

/** Mark payment due at completion. Idempotent. Mutates `job` — caller saves. */
function markPaymentDue(job) {
  if (job.source !== 'user') return null;
  if (job.payment && job.payment.status !== 'not_due') return job.payment;
  job.payment = job.payment || {};
  job.payment.status = 'due';
  job.payment.amount = (job.pricing && job.pricing.userPrice) || job.payment.amount || 0;
  job.payment.currency = (job.pricing && job.pricing.currency) || CURRENCY;
  job.payment.dueAt = new Date();
  return job.payment;
}

async function initiateTrialPayment(job, { method }) {
  if (!isPayable(job)) {
    return {
      ok: false,
      httpCode: 409,
      reason:
        job.status === 'assigned' || job.status === 'accepted' || job.status === 'in_progress'
          ? 'You can pay once the professional marks the work done'
          : `Nothing to pay on a trial in "${job.status}"`,
    };
  }
  if (!method || !gateway.METHODS.includes(method)) {
    return { ok: false, httpCode: 422, reason: `method must be one of: ${gateway.METHODS.join(', ')}` };
  }

  const payment = job.payment || {};
  if (payment.status === 'paid') return { ok: true, job, payment: job.payment, alreadyPaid: true };
  // Self-heal a job that reached `completed` without markPaymentDue running.
  if (payment.status === 'not_due') markPaymentDue(job);

  const amount = (job.pricing && job.pricing.userPrice) || job.payment.amount || 0;
  if (!amount) return { ok: false, httpCode: 409, reason: 'This trial has no priced amount to pay' };

  const order = await gateway.createOrder({
    amount,
    currency: job.payment.currency || CURRENCY,
    method,
    reference: String(job._id),
    label: 'trial',
  });

  job.payment.status = 'processing';
  job.payment.method = method;
  job.payment.amount = amount;
  job.payment.orderId = order.orderId;
  job.payment.provider = order.provider;
  job.payment.initiatedAt = new Date();
  job.payment.attempts = (job.payment.attempts || 0) + 1;
  job.payment.failureReason = null;
  job.payment.failedAt = undefined;
  await job.save();

  return { ok: true, job, payment: job.payment };
}

/**
 * Capture the customer's payment and credit their reward.
 *
 * Same guarantees as the normal payment flow: exactly one concurrent confirm can
 * flip `processing` → `paid` (atomic conditional update), and the reward write
 * happens AFTER capture so a crash in between leaves a paid trial with no reward
 * row — recoverable — rather than a rewarded customer who never paid.
 */
async function confirmTrialPayment(job, { orderId, gatewayReference } = {}) {
  const payment = job.payment || {};

  if (payment.status === 'paid') {
    await creditUserReward(job).catch((err) =>
      console.error('[user-trial] reward retry failed for job', String(job._id), err.message)
    );
    // Same retry reasoning as the cashback above: a crash between capture and
    // the referral payout leaves it unpaid, and both are idempotent.
    await referral.creditOnFirstPaymentSafe(job.requestedBy);
    return { ok: true, job, payment: job.payment, alreadyPaid: true, rewarded: false };
  }
  if (payment.status !== 'processing') {
    return {
      ok: false,
      httpCode: 409,
      reason:
        payment.status === 'due' || payment.status === 'failed'
          ? 'Start a payment first (POST /payment/initiate)'
          : 'This trial has no payment to confirm yet',
    };
  }
  if (orderId && String(orderId) !== String(payment.orderId)) {
    return { ok: false, httpCode: 409, reason: 'orderId does not match the payment in progress' };
  }

  const result = await gateway.capture({
    orderId: payment.orderId,
    gatewayReference,
    amount: payment.amount,
  });

  if (!result.captured) {
    job.payment.status = 'failed';
    job.payment.failedAt = new Date();
    job.payment.failureReason = result.reason || 'Payment failed';
    await job.save();
    return { ok: false, httpCode: 402, reason: job.payment.failureReason, job };
  }

  const now = new Date();
  const claimed = await TrialJob.findOneAndUpdate(
    { _id: job._id, 'payment.status': 'processing' },
    {
      $set: {
        'payment.status': 'paid',
        'payment.paidAt': now,
        'payment.transactionId': result.transactionId,
        'payment.provider': result.provider,
        'payment.failureReason': null,
      },
    },
    { new: true }
  );

  if (!claimed) {
    const fresh = await TrialJob.findById(job._id);
    return { ok: true, job: fresh, payment: fresh.payment, alreadyPaid: true, rewarded: false };
  }

  const reward = await creditUserReward(claimed);
  // A trial counts as the invited customer's first booking. Deliberately after
  // the capture and never allowed to throw — a referral must not be able to
  // turn a confirmed payment into an error response.
  await referral.creditOnFirstPaymentSafe(claimed.requestedBy);
  const finalJob = reward.job || claimed;
  await pushToCustomer(finalJob, 'trial:paid', { rewardCredited: reward.created });
  return { ok: true, job: finalJob, payment: finalJob.payment, rewarded: reward.created, reward: reward.transaction };
}

/**
 * Write the customer's cashback into their reward ledger.
 *
 * Idempotent — safe to re-run after a crash, which is why the already-paid path
 * above calls it too. The unique index on { source, sourceId, type } is the
 * database-level backstop behind this check.
 */
async function creditUserReward(job) {
  if (!job.requestedBy) return { created: false, job, reason: 'no customer' };
  if (!job.payment || job.payment.status !== 'paid') {
    return { created: false, job, reason: 'payment not captured' };
  }

  const existing = await UserWalletTransaction.findOne({
    source: 'trial_reward',
    sourceId: job._id,
    type: 'credit',
  });
  if (existing) return { created: false, job, transaction: existing };

  const pricing = job.pricing || {};
  const paid = job.payment.amount || pricing.userPrice || 0;
  const percent = pricing.userRewardPercent ?? pricing.userWalletCreditPercent ?? 0;
  const amount = pricing.userReward ?? pricing.userWalletCredit ?? Math.round(paid * (percent / 100));

  if (!amount) return { created: false, job, reason: 'no reward configured' };

  let transaction;
  try {
    transaction = await UserWalletTransaction.create({
      user: job.requestedBy,
      type: 'credit',
      amount,
      currency: job.payment.currency || pricing.currency || CURRENCY,
      source: 'trial_reward',
      sourceId: job._id,
      basedOnAmount: paid,
      percent,
      paymentTransactionId: job.payment.transactionId || null,
      note: `Trial reward · ${percent}% of ₹${paid}`,
    });
  } catch (err) {
    // 11000 = the unique index fired, i.e. a concurrent credit won. Guard working.
    if (err.code !== 11000) throw err;
    const winner = await UserWalletTransaction.findOne({
      source: 'trial_reward',
      sourceId: job._id,
      type: 'credit',
    });
    return { created: false, job, transaction: winner };
  }

  const updated = await TrialJob.findByIdAndUpdate(
    job._id,
    { $set: { 'reward.amount': amount, 'reward.percent': percent, 'reward.creditedAt': transaction.createdAt } },
    { new: true }
  );

  console.log(
    `🎁 Customer rewarded ₹${amount} (${percent}% of ₹${paid}) · user ${job.requestedBy} · trial ${job._id}`
  );

  return { created: true, job: updated || job, transaction };
}

module.exports = {
  checkEligibility,
  findCandidates,
  createTrialBooking,
  retryTrialBooking,
  cancelTrialBooking,
  offerToCandidate,
  rollToNextCandidate,
  markPaymentDue,
  initiateTrialPayment,
  confirmTrialPayment,
  creditUserReward,
  pushToCustomer,
  isPayable,
  validCoord,
  TRIAL_CATEGORY: USER_TRIAL_CATEGORY,
};
