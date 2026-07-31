const mongoose = require('mongoose');

/**
 * Filter 2: the single subsidised "trial job" a worker does after clearing
 * application review and before being fully approved.
 *
 * Unlike a normal ServiceRequest (geo-broadcast, first-to-accept, wave/radius),
 * a trial job is DIRECTED: it is offered to ONE specific worker at a time, so
 * there is no dispatch engine here — just a directed offer with a countdown.
 *
 * Two things can create one (`source`):
 *   'admin' → ops picks the worker by hand in the dashboard.
 *   'user'  → a customer books a discounted trial from the app; the server picks
 *             the nearest workers awaiting a trial and offers to them in turn.
 *             See services/userTrialService.
 *
 * Job lifecycle (`status`) — identical for both sources, which is why the worker
 * app needed no changes to support customer-booked trials:
 *   assigned    → offered to the worker, countdown running (offerExpiresAt)
 *   accepted    → worker accepted the offer
 *   in_progress → worker started the job
 *   completed   → worker finished checkout; customer feedback now requested
 *   declined    → worker declined (declinedReason='worker_declined')
 *   expired     → offer countdown lapsed (declinedReason='timeout')
 *
 * For a user-booked trial, `declined` and `expired` are only reached once the
 * whole `candidates` list is used up: a decline or timeout rolls the offer to the
 * next candidate (`worker` is reassigned and the countdown restarts) rather than
 * killing the booking. An admin-assigned trial has no candidates, so it behaves
 * exactly as it always did.
 *
 * The worker's own APPLICATION_STATUS tracks the parallel worker-side state
 * (trial_assigned/…); see services/workerStatusService.
 */

const TRIAL_JOB_STATUS = ['assigned', 'accepted', 'in_progress', 'completed', 'declined', 'expired'];

// Customer's 10-answer feedback + the engine's verdict. Embedded 1:1 because a
// trial job has exactly one feedback record. Initialised (decision=null,
// slaDeadlineAt set) at job completion; answers land when the customer submits.
const feedbackSchema = new mongoose.Schema(
  {
    // Raw answers keyed q1..q10 (q10 is free-text notes). Validated against
    // config/trialQuestions.js at the controller before landing here.
    answers: {
      q1: String, q2: String, q3: String, q4: String, q5: String,
      q6: String, q7: String, q8: String, q9: String, q10: String,
    },
    decision: { type: String, enum: ['strong_pass', 'conditional', 'fail'], default: null },
    // 'user_app' = submitted in-session by the logged-in customer who booked it.
    // 'sms_link' = the tokenised public form, still used for admin-assigned
    // trials where the host has no account.
    submittedVia: { type: String, enum: ['sms_link', 'admin', 'user_app'], default: null },
    submittedAt: { type: Date, default: null },

    // SLA watcher fields (see services/trialJobsService).
    slaDeadlineAt: { type: Date, default: null },   // job.completedAt + FEEDBACK_SLA_MINUTES
    reminderSentAt: { type: Date, default: null },  // 30-min reminder fired
    overdueAlerted: { type: Boolean, default: false }, // ops flagged as overdue

    // Set only when an admin manually finalises a `conditional` result.
    reviewedByAdmin: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    finalizedAt: { type: Date, default: null },
  },
  { _id: false }
);

// One candidate = a `pending_trial` worker this booking may be offered to. Built
// once at creation from the geo query, then walked in order. Only ever ONE is
// 'offered' at a time, because a trial is a directed job.
const candidateSchema = new mongoose.Schema(
  {
    worker: { type: mongoose.Schema.Types.ObjectId, ref: 'Worker', required: true },
    distanceKm: Number,
    order: Number, // 0-based position in the queue, nearest first
    status: {
      type: String,
      enum: ['queued', 'offered', 'accepted', 'declined', 'expired', 'skipped'],
      default: 'queued',
    },
    offeredAt: Date,
    closedAt: Date, // when this candidate stopped being the active offer
  },
  { _id: false }
);

const trialJobSchema = new mongoose.Schema(
  {
    // The worker the offer is CURRENTLY with. Reassigned as the candidate queue
    // is walked, so it always names whoever may act on the job right now — which
    // is what the worker-side ownership check reads.
    worker: { type: mongoose.Schema.Types.ObjectId, ref: 'Worker', required: true, index: true },
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },

    // Who created this. 'admin' is the original ops-driven path; 'user' is a
    // customer booking it themselves from the app.
    source: { type: String, enum: ['admin', 'user'], default: 'admin', index: true },

    // The customer account that booked it — null for admin-assigned trials,
    // where the host has no account. Everything customer-facing keys off this.
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },

    // The trial "host" customer. For a user booking this is snapshotted from the
    // account (same reasoning as ServiceRequest.customer: the worker's view of a
    // past job shouldn't change when the customer renames themselves).
    host: {
      name: { type: String, required: true },
      phone: { type: String, required: true },
    },

    // The offer queue for a user-booked trial. Empty for admin assignments.
    candidates: [candidateSchema],
    // Index into `candidates` of the active offer; -1 once the queue is spent.
    candidateIndex: { type: Number, default: -1 },
    // Deadline for the WHOLE search across all candidates — what the customer's
    // "finding a professional" screen counts down to. Distinct from
    // `offerExpiresAt`, which is just the current worker's turn.
    searchExpiresAt: { type: Date, default: null },

    // 1 for the original search; incremented by each customer retry, which
    // rebuilds `candidates` from a fresh geo query.
    searchAttempt: { type: Number, default: 1 },

    category: { type: String, required: true },
    subcategory: { type: String, default: null },
    jobDescription: { type: String, required: true },
    scheduledTime: { type: Date, default: null },

    // GeoJSON Point [lng, lat] — stored for parity with ServiceRequest even
    // though there is no geo-matching for a directed trial.
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], required: true }, // [lng, lat]
    },
    address: { type: String, default: '' },

    // Trial pricing, computed once at assignment (pricingService.computeTrialPrice).
    // basePrice → discounted userPrice (what the user pays); worker keeps the full
    // userPrice (no commission); userWalletCredit is the user-side cashback amount.
    pricing: {
      currency: String,
      basePrice: Number,
      userPrice: Number,
      totalPrice: Number,          // alias of userPrice (ServiceRequest compatibility)
      userDiscountPercent: Number,
      platformFeePercent: Number,
      platformFee: Number,
      workerEarning: Number,
      userWalletCreditPercent: Number,
      userWalletCredit: Number,
    },

    status: { type: String, enum: TRIAL_JOB_STATUS, default: 'assigned', index: true },

    offerExpiresAt: { type: Date },        // countdown for the offer screen
    acceptedAt: Date,
    startedAt: Date,
    completedAt: Date,
    declinedAt: Date,
    // 'customer_cancelled' only occurs on user-booked trials. The job `status`
    // stays 'declined' for that case rather than gaining a 'cancelled' value,
    // because the worker app switches on these job statuses and an unknown one
    // would fall through its routing — the reason field carries the detail.
    declinedReason: {
      type: String,
      enum: ['worker_declined', 'timeout', 'customer_cancelled', null],
      default: null,
    },

    // Checkout payload from the worker (same shape as a normal job checkout).
    checkout: {
      photos: [String],
      notes: { type: String, default: '' },
    },

    feedback: { type: feedbackSchema, default: () => ({}) },

    // ── Customer payment (user-booked trials only) ────────────────
    // Same state machine and field names as ServiceRequest.payment, so the
    // customer app renders one payment screen for both flows. The difference is
    // what a capture triggers: a normal job credits the WORKER's ledger, whereas
    // a trial credits the CUSTOMER's reward and leaves the worker's earning to
    // the existing approval-time settlement (trialSettlementService), since a
    // trial only pays out if it's approved.
    payment: {
      status: {
        type: String,
        enum: ['not_due', 'due', 'processing', 'paid', 'failed'],
        default: 'not_due',
        index: true,
      },
      amount: Number,
      currency: { type: String, default: 'INR' },
      method: { type: String, enum: ['upi', 'card', 'netbanking', 'wallet', 'cash'], default: null },
      orderId: { type: String, default: null, index: true },
      transactionId: { type: String, default: null },
      provider: { type: String, default: null },
      dueAt: Date,
      initiatedAt: Date,
      paidAt: Date,
      failedAt: Date,
      failureReason: { type: String, default: null },
      attempts: { type: Number, default: 0 },
    },

    // The cashback credited to the customer for taking the trial — 40% of what
    // they paid, by default. Written once, when payment is captured.
    reward: {
      amount: Number,
      percent: Number,
      creditedAt: { type: Date, default: null },
    },

    // Settlement: on approval the trial is materialised as a completed
    // ServiceRequest so it flows through the standard earnings/wallet/history
    // pipeline (which reads ServiceRequest). Set once, guards against double-credit.
    settledAt: { type: Date, default: null },
    settledServiceRequest: { type: mongoose.Schema.Types.ObjectId, ref: 'ServiceRequest', default: null },
  },
  { timestamps: true }
);

trialJobSchema.index({ location: '2dsphere' });

// "This customer's trial bookings, newest first" — the customer app's hot read.
trialJobSchema.index({ requestedBy: 1, createdAt: -1 });

trialJobSchema.statics.STATUS = TRIAL_JOB_STATUS;

// Non-terminal: the job itself hasn't finished. `declined` and `expired` are
// absent — for a user booking those are only reached once the candidate queue is
// spent, which is a dead end the customer retries out of.
const LIVE_STATUSES = ['assigned', 'accepted', 'in_progress', 'completed'];
trialJobSchema.statics.LIVE_STATUSES = LIVE_STATUSES;

// The work is still to be done.
const IN_FLIGHT_STATUSES = ['assigned', 'accepted', 'in_progress'];
trialJobSchema.statics.IN_FLIGHT_STATUSES = IN_FLIGHT_STATUSES;

// Statuses that consume a customer's trial allowance: a worker actually took the
// booking on. A booking nobody ever accepted (declined/expired with the queue
// spent) deliberately does NOT count — the customer got no service, so charging
// them their one discounted trial would be punitive. Neither does a booking still
// out for offer, since the concurrency guard already stops a second one.
trialJobSchema.statics.ALLOWANCE_STATUSES = ['accepted', 'in_progress', 'completed'];

/**
 * Bookings that still need something from the customer.
 *
 * NOT the same as "not terminal": a `completed` trial that has been paid for AND
 * rated is finished as far as the customer is concerned and belongs in history,
 * even though its status stays `completed` forever (there is no later status —
 * the worker's onboarding decision lives on the Worker, not here).
 *
 * Keying "active" off LIVE_STATUSES alone left every finished trial pinned to the
 * active screen permanently, and — with an allowance above 1 — would have blocked
 * the customer from ever booking another.
 */
trialJobSchema.statics.needsCustomerQuery = function needsCustomerQuery(userId) {
  return {
    requestedBy: userId,
    $or: [
      { status: { $in: IN_FLIGHT_STATUSES } },
      // Finished, but the form that onboards the worker is still outstanding.
      { status: 'completed', 'feedback.submittedAt': null },
      // Finished, but not yet paid for.
      { status: 'completed', 'payment.status': { $in: ['not_due', 'due', 'processing', 'failed'] } },
    ],
  };
};

// Is this document one of those? Same rule as the query above, applied in memory
// so a list read doesn't need a second round trip to classify its own rows.
trialJobSchema.statics.needsCustomer = function needsCustomer(job) {
  if (IN_FLIGHT_STATUSES.includes(job.status)) return true;
  if (job.status !== 'completed') return false;
  const paid = job.payment && job.payment.status === 'paid';
  const rated = job.feedback && job.feedback.submittedAt;
  return !paid || !rated;
};

module.exports = mongoose.model('TrialJob', trialJobSchema);
