/**
 * Single choke-point for server-driven worker.status changes in the trial
 * pipeline. Every transition:
 *   1. updates worker.status (+ a human-readable reviewLog entry),
 *   2. records an append-only WorkerStatusTransition row for audit/disputes,
 *   3. pushes a `worker:status_changed` event to the worker's socket room so
 *      the app moves to the matching screen without polling.
 *
 * The client can NEVER set status directly — it only ever arrives here.
 */

const WorkerStatusTransition = require('../models/WorkerStatusTransition');
const emitter = require('../realtime/emitter');

/**
 * Transition a worker to `toStatus` and fan out the side effects.
 * @param {Document} worker  a Mongoose Worker document (mutated + saved)
 * @param {string}   toStatus
 * @param {object}   opts { actor='system', reason='', trialJob=null, emit=true }
 */
async function transitionWorker(worker, toStatus, opts = {}) {
  const { actor = 'system', reason = '', trialJob = null, emit = true } = opts;
  const fromStatus = worker.status;

  // No-op guard: don't log/emit a transition that changes nothing.
  if (fromStatus === toStatus) return worker;

  worker.status = toStatus;
  worker.reviewLog.push({ action: `status:${toStatus}`, by: actor, message: reason });
  await worker.save();

  // Audit trail — non-fatal if it fails (the status change already landed).
  try {
    await WorkerStatusTransition.create({
      worker: worker._id,
      fromStatus,
      toStatus,
      actor,
      reason,
      trialJob,
    });
  } catch (err) {
    console.error(`[worker-status] failed to log transition ${fromStatus}→${toStatus}:`, err.message);
  }

  if (emit) {
    emitter.emitToWorker(worker._id, 'worker:status_changed', { status: toStatus, reason: reason || undefined });
  }

  return worker;
}

module.exports = { transitionWorker };
