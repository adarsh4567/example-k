const mongoose = require('mongoose');

/**
 * Filter 2: the single subsidised "trial job" a worker does after clearing
 * application review and before being fully approved.
 *
 * Unlike a normal ServiceRequest (geo-broadcast, first-to-accept, wave/radius),
 * a trial job is DIRECTED: an admin assigns it to one specific worker, so there
 * is no dispatch engine here — just a directed offer with a countdown.
 *
 * Job lifecycle (`status`):
 *   assigned    → offered to the worker, countdown running (offerExpiresAt)
 *   accepted    → worker accepted the offer
 *   in_progress → worker started the job
 *   completed   → worker finished checkout; customer feedback now requested
 *   declined    → worker declined (declinedReason='worker_declined')
 *   expired     → offer countdown lapsed (declinedReason='timeout')
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
    submittedVia: { type: String, enum: ['sms_link', 'admin'], default: null },
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

const trialJobSchema = new mongoose.Schema(
  {
    worker: { type: mongoose.Schema.Types.ObjectId, ref: 'Worker', required: true, index: true },
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },

    // The trial "host" customer — entered by the admin (no customer app yet).
    host: {
      name: { type: String, required: true },
      phone: { type: String, required: true },
    },

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

    // Subsidised pricing, computed once at assignment (pricingService.computeTrialPrice).
    pricing: {
      currency: String,
      totalPrice: Number,
      platformFeePercent: Number,
      platformFee: Number,
      workerEarning: Number,
      trialRatePercent: Number,
      standardTotalPrice: Number,
    },

    status: { type: String, enum: TRIAL_JOB_STATUS, default: 'assigned', index: true },

    offerExpiresAt: { type: Date },        // countdown for the offer screen
    acceptedAt: Date,
    startedAt: Date,
    completedAt: Date,
    declinedAt: Date,
    declinedReason: { type: String, enum: ['worker_declined', 'timeout', null], default: null },

    // Checkout payload from the worker (same shape as a normal job checkout).
    checkout: {
      photos: [String],
      notes: { type: String, default: '' },
    },

    feedback: { type: feedbackSchema, default: () => ({}) },
  },
  { timestamps: true }
);

trialJobSchema.index({ location: '2dsphere' });
trialJobSchema.statics.STATUS = TRIAL_JOB_STATUS;

module.exports = mongoose.model('TrialJob', trialJobSchema);
