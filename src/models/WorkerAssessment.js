const mongoose = require('mongoose');

/**
 * Filter 3: the central record for one in-person electrical shop assessment,
 * from booking through to the admin's final decision.
 *
 * Lifecycle (`status`):
 *   booked            → slot reserved, assessment upcoming
 *   worker_arrived    → worker checked in within the shop geofence
 *   feedback_submitted→ shop owner submitted the feedback form; awaiting admin
 *   approved / rejected → admin made the final call
 *   no_show           → worker never checked in (partner-marked or swept)
 *   cancelled         → worker cancelled ≥24h out, or the slot was withdrawn
 *
 * `feedback` and `payment` are embedded rather than separate collections because
 * both are strictly 1:1 with the assessment — the same choice TrialJob.feedback
 * makes. Their fields are still individually indexable for the ops dashboards.
 *
 * Note: unlike the trial-job engine, the score here NEVER auto-transitions the
 * worker. Every assessment goes through an explicit admin decision; the engine
 * only produces a recommendation and the safety flag.
 */

const ASSESSMENT_STATUS = [
  'booked',
  'confirmed',           // reserved for an optional shop-owner confirmation step
  'worker_arrived',
  'assessment_complete', // session done, feedback not yet in (set alongside feedback)
  'feedback_submitted',
  'approved',
  'rejected',
  'no_show',
  'cancelled',
];

// Statuses that mean "this assessment is still in flight" — a worker may only
// hold one of these at a time.
const LIVE_STATUSES = ['booked', 'confirmed', 'worker_arrived', 'assessment_complete', 'feedback_submitted'];

// The structured form the shop owner submits. Answers are validated against
// config/assessmentQuestions before landing here.
const feedbackSchema = new mongoose.Schema(
  {
    // The critical safety question — false is a hard safety failure.
    isolatedCircuitBeforeTouching: { type: Boolean, default: null },
    toolHandlingScore: { type: Number, default: null },   // 1..5
    repairQualityScore: { type: Number, default: null },  // 1..5
    askedSensibleQuestions: { type: Boolean, default: null },
    wouldHireInShop: { type: String, enum: ['yes', 'maybe', 'no', null], default: null },
    overallRecommendation: {
      type: String,
      enum: ['onboard', 'do_not_onboard', 'maybe', null],
      default: null,
    },
    tasksPerformed: { type: String, default: '' },
    additionalNotes: { type: String, default: '' },

    // Engine output (services/assessmentScoreService) — advisory only.
    preliminaryScore: { type: Number, default: null }, // 0..100
    safetyFailed: { type: Boolean, default: false },
    engineRecommendation: {
      type: String,
      enum: ['approve', 'review', 'reject', null],
      default: null,
    },
    scoreBreakdown: { type: mongoose.Schema.Types.Mixed, default: null },

    submittedVia: { type: String, enum: ['web_form', 'whatsapp', 'admin', null], default: null },
    // Set only when an admin entered the feedback on the shop owner's behalf
    // (owner phoned it in, or has no smartphone). submittedVia is then 'admin'.
    submittedByAdmin: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    submittedAt: { type: Date, default: null },

    // SLA watcher fields (see services/assessmentJobsService).
    slaDeadlineAt: { type: Date, default: null },
    reminderSentAt: { type: Date, default: null },
    overdueAlerted: { type: Boolean, default: false },
  },
  { _id: false }
);

// The split payout to the shop owner: half on feedback, half once the worker
// they approved has proven out on the platform.
const paymentSchema = new mongoose.Schema(
  {
    upfrontAmount: { type: Number, default: 0 },
    deferredAmount: { type: Number, default: 0 },
    totalAmount: { type: Number, default: 0 },

    upfrontPaid: { type: Boolean, default: false },
    upfrontPaidAt: { type: Date, default: null },
    upfrontReference: { type: String, default: null },

    deferredPaid: { type: Boolean, default: false },
    deferredPaidAt: { type: Date, default: null },
    deferredReference: { type: String, default: null },
    // What released the deferred half, e.g. 'worker completed 10 jobs'.
    deferredTriggerEvent: { type: String, default: null },

    method: { type: String, default: null },
  },
  { _id: false }
);

const workerAssessmentSchema = new mongoose.Schema(
  {
    worker: { type: mongoose.Schema.Types.ObjectId, ref: 'Worker', required: true, index: true },
    shopPartner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ShopPartner',
      required: true,
      index: true,
    },
    slot: { type: mongoose.Schema.Types.ObjectId, ref: 'AssessmentSlot', required: true },

    scheduledAt: { type: Date, required: true, index: true },
    scheduledEndAt: { type: Date, required: true },

    status: { type: String, enum: ASSESSMENT_STATUS, default: 'booked', index: true },

    // Which attempt this is for the worker (a no-show or withdrawn slot lets them rebook).
    attempt: { type: Number, default: 1 },

    workerArrivedAt: { type: Date, default: null },
    // Where the worker actually was when they checked in — kept for dispute review.
    checkInLocation: {
      type: { type: String, enum: ['Point'] },
      coordinates: { type: [Number] }, // [lng, lat]
    },
    checkInDistanceMeters: { type: Number, default: null },
    // 'worker' = the geofenced in-app check-in; 'admin' = an ops override (e.g. the
    // worker's phone died, or ops is running the session through the panel). An
    // admin override skips the geofence and the time window, so record which it was.
    checkedInBy: { type: String, enum: ['worker', 'admin', null], default: null },

    assessmentCompletedAt: { type: Date, default: null },
    feedbackSubmittedAt: { type: Date, default: null },

    feedback: { type: feedbackSchema, default: () => ({}) },
    payment: { type: paymentSchema, default: () => ({}) },

    // Admin's final call. `status` mirrors this once decided.
    finalDecision: { type: String, enum: ['approved', 'rejected', null], default: null },
    finalDecisionBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    finalDecisionAt: { type: Date, default: null },
    finalDecisionNotes: { type: String, default: null },

    cancellationReason: { type: String, default: null },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: String, enum: ['worker', 'admin', 'partner', null], default: null },
    // A worker may cancel right up to the slot start, but a cancellation inside
    // LATE_CANCEL_WINDOW_HOURS still costs the shop owner the slot they held, so
    // it is recorded for ops rather than treated as routine.
    cancelledLate: { type: Boolean, default: false },
    cancelledHoursBefore: { type: Number, default: null },

    noShowMarkedAt: { type: Date, default: null },
    noShowMarkedBy: { type: String, enum: ['partner', 'system', 'admin', null], default: null },
  },
  { timestamps: true }
);

// The admin review queue: status=feedback_submitted, oldest feedback first.
workerAssessmentSchema.index({ status: 1, feedbackSubmittedAt: 1 });
// The deferred-payout sweep.
workerAssessmentSchema.index({ 'payment.upfrontPaid': 1, 'payment.deferredPaid': 1 });

workerAssessmentSchema.statics.STATUS = ASSESSMENT_STATUS;
workerAssessmentSchema.statics.LIVE_STATUSES = LIVE_STATUSES;

module.exports = mongoose.model('WorkerAssessment', workerAssessmentSchema);
module.exports.LIVE_STATUSES = LIVE_STATUSES;
