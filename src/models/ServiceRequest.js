const mongoose = require('mongoose');

/**
 * A customer's on-demand service request and its dispatch lifecycle.
 *
 *   searching      → offers broadcast to nearby workers, waiting for someone to accept
 *   in_progress    → a worker accepted (first-to-accept-wins); work is ongoing
 *   pending_rating → the worker marked the on-site work done, but the job is
 *                    NOT yet completed — it only becomes `completed` once the
 *                    worker submits their 1-5 rating for the job. The worker
 *                    stays bound to this request (no new offers) throughout.
 *                    Payment becomes DUE at this point (see `payment` below):
 *                    the customer can pay as soon as the work is physically
 *                    done, without waiting on the worker's rating tap.
 *   completed      → rating submitted; job fully closed
 *   cancelled      → the customer cancelled
 *   expired        → nobody accepted within the search window (see `searchExpiresAt`).
 *                    NOT terminal from the customer's point of view — they can
 *                    retry, which flips this row back to `searching` with a new
 *                    `attempt`. See dispatchService.retryRequest.
 *
 * Payment runs on its own track (`payment.status`) rather than as extra values in
 * the status enum above, because the two are genuinely independent: the WORKER
 * drives the job status and the CUSTOMER drives the payment, and the worker app
 * must not have to learn about payment states to keep working. Adding e.g. a
 * `paid` job status would have changed what the worker app sees on
 * GET /api/jobs/mine; a parallel field it never reads changes nothing for it.
 */

const REQUEST_STATUS = ['searching', 'in_progress', 'pending_rating', 'completed', 'cancelled', 'expired'];

// not_due   → work isn't done yet, so there is nothing to pay
// due       → work is done; waiting for the customer to pay
// processing→ customer opened a payment; waiting for gateway confirmation
// paid      → money captured AND the worker's credit written to the ledger
// failed    → the gateway declined; the customer can start another attempt
const PAYMENT_STATUS = ['not_due', 'due', 'processing', 'paid', 'failed'];

const PAYMENT_METHODS = ['upi', 'card', 'netbanking', 'wallet', 'cash'];

// One offer = the request being shown to one worker in a given dispatch wave.
const offerSchema = new mongoose.Schema(
  {
    worker: { type: mongoose.Schema.Types.ObjectId, ref: 'Worker', required: true },
    distanceKm: Number,
    wave: Number,
    // Which search attempt this offer belongs to (1 = original, 2+ = retries).
    // Dispatch excludes only workers already offered THIS attempt, so a retry
    // legitimately re-offers to everyone who ignored the previous one.
    attempt: { type: Number, default: 1 },
    status: {
      type: String,
      enum: ['offered', 'accepted', 'declined', 'missed'],
      default: 'offered',
    },
    offeredAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const serviceRequestSchema = new mongoose.Schema(
  {
    // The logged-in customer who raised this. Null only for requests created
    // through the legacy unauthenticated POST /api/service-requests, which
    // predates the customer app having accounts and is kept for test scripts.
    // Everything customer-facing (list my requests, retry, pay) keys off this,
    // so a null-user request is invisible to the customer app by construction.
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },

    // Denormalised name + phone as the WORKER sees them, snapshotted at creation.
    // Copied off the User rather than joined at read time so the worker's view of
    // a past job doesn't silently change when the customer renames themselves.
    customer: {
      name: { type: String, required: true },
      phone: { type: String, required: true },
    },

    category: { type: String, required: true },     // e.g. 'cleaning'
    subcategory: { type: String, default: null },   // optional, e.g. 'kitchen'

    // Free-text description of the job, written by the customer. The only
    // customer-supplied field shown verbatim to the worker as-is.
    jobDescription: { type: String, required: true },

    // DUMMY for now — no customer rating system exists yet. Every request
    // carries this same placeholder so the worker sees a rating pre-accept,
    // mirroring how ride-hailing apps show rider rating to the driver.
    customerRating: { type: Number, default: 4.6 },

    // DUMMY rate-card pricing, computed once at creation (see pricingService).
    pricing: {
      currency: String,
      totalPrice: Number,
      platformFeePercent: Number,
      platformFee: Number,
      workerEarning: Number,
    },

    // Where the service is needed. GeoJSON Point [lng, lat].
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], required: true }, // [lng, lat]
    },
    address: String,

    status: { type: String, enum: REQUEST_STATUS, default: 'searching', index: true },

    // Dispatch state
    radiusKm: Number,          // current search radius
    initialRadiusKm: Number,
    maxRadiusKm: Number,
    wave: { type: Number, default: 0 },
    dispatchExpiresAt: Date,   // when the current wave times out (sweeper acts after this)

    // ── The customer-visible countdown ──────────────────────────
    // One search ATTEMPT lasts SEARCH_WINDOW_SECONDS (1 minute by default) end
    // to end, however many waves fit inside it. `searchExpiresAt` is the single
    // authority for that deadline: the sweeper expires the request the moment it
    // passes, and the customer app renders its timer from it rather than counting
    // locally from createdAt — so a client that was backgrounded, or whose clock
    // is skewed, still agrees with the server about when the search died.
    searchStartedAt: Date,
    searchExpiresAt: Date,

    // 1 for the original search, incremented by each retry. Capped at
    // MAX_ATTEMPTS (dispatchConfig) so retries can't cycle forever.
    attempt: { type: Number, default: 1 },

    offers: [offerSchema],

    acceptedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Worker', default: null },
    acceptedAt: Date,
    workDoneAt: Date,     // when the worker tapped "Complete" (entered pending_rating)
    completedAt: Date,    // when the rating was submitted (job fully closed)
    cancelledAt: Date,
    expiredAt: Date,

    // The worker's 1-5 rating for this job, submitted at completion. Required
    // to transition pending_rating → completed; null until then.
    jobRating: { type: Number, min: 1, max: 5, default: null },
    ratedAt: Date,

    // ── Payment (customer pays) → worker credit ──────────────────
    // `amount` is snapshotted from pricing.totalPrice when payment falls due, so
    // a later rate-card change can never alter what an already-finished job costs.
    // The worker's cut is recorded in the WalletTransaction ledger, not here.
    payment: {
      status: { type: String, enum: PAYMENT_STATUS, default: 'not_due', index: true },
      amount: Number,
      currency: { type: String, default: 'INR' },
      method: { type: String, enum: PAYMENT_METHODS, default: null },

      // Gateway handles. `orderId` is minted by us at initiate and echoed back by
      // the client at confirm — it's what ties a confirm to the attempt that
      // opened it, so a stale retry of an old confirm can't capture a new order.
      orderId: { type: String, default: null, index: true },
      transactionId: { type: String, default: null },
      provider: { type: String, default: null },

      dueAt: Date,
      initiatedAt: Date,
      paidAt: Date,
      failedAt: Date,
      failureReason: { type: String, default: null },
      attempts: { type: Number, default: 0 },

      // Set when the worker's ledger credit has been written. Separate from
      // paidAt because capture and settlement are different events — a real
      // payout provider will make the gap visible.
      workerCreditedAt: Date,
      workerCreditAmount: Number,
    },

    notes: String,
  },
  { timestamps: true }
);

serviceRequestSchema.index({ location: '2dsphere' });

// The customer app's two hot reads: "my current request" and "my history".
serviceRequestSchema.index({ user: 1, status: 1, createdAt: -1 });

serviceRequestSchema.statics.STATUS = REQUEST_STATUS;
serviceRequestSchema.statics.PAYMENT_STATUS = PAYMENT_STATUS;
serviceRequestSchema.statics.PAYMENT_METHODS = PAYMENT_METHODS;

// "This customer has something on the go." Note `expired` is absent: an expired
// request is retryable, so it is not open — but it also isn't finished, which is
// why the customer app keeps showing it until they retry or walk away.
const OPEN_STATUSES = ['searching', 'in_progress', 'pending_rating'];
serviceRequestSchema.statics.OPEN_STATUSES = OPEN_STATUSES;

/**
 * Everything the customer app should have on screen right now: work still in
 * flight, plus work that is finished but not yet paid for.
 *
 * A static rather than a copy in each caller because two places need exactly this
 * predicate — the REST "what should I render on launch" endpoint and the socket's
 * on-connect snapshot — and they have to agree. If they drift, an app that
 * reconnects sees a different set of live requests than one that polls.
 */
serviceRequestSchema.statics.liveForUserQuery = function liveForUserQuery(userId) {
  return {
    user: userId,
    $or: [
      { status: { $in: OPEN_STATUSES } },
      { status: 'completed', 'payment.status': { $in: ['due', 'processing', 'failed'] } },
    ],
  };
};

module.exports = mongoose.model('ServiceRequest', serviceRequestSchema);
