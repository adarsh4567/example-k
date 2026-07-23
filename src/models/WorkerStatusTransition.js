const mongoose = require('mongoose');

/**
 * Append-only audit of every worker.status change made by the trial pipeline
 * (and any other server-driven transition routed through
 * services/workerStatusService). Kept in its own collection so disputes
 * ("why was I rejected?") and decision-engine tuning have a clean, queryable
 * history without bloating the Worker document.
 *
 * `actor` is 'system' for automatic transitions (offer timeout, decision
 * engine) or the admin's email for manual ones.
 */
const workerStatusTransitionSchema = new mongoose.Schema(
  {
    worker: { type: mongoose.Schema.Types.ObjectId, ref: 'Worker', required: true, index: true },
    fromStatus: { type: String, default: null },
    toStatus: { type: String, required: true },
    actor: { type: String, default: 'system' }, // 'system' | admin email
    reason: { type: String, default: '' },
    // Optional link to the trial job that caused the transition (if any).
    trialJob: { type: mongoose.Schema.Types.ObjectId, ref: 'TrialJob', default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('WorkerStatusTransition', workerStatusTransitionSchema);
