/**
 * Background maintenance for the trial-job filter. Two responsibilities, run on
 * one interval (mirrors dispatchService's sweeper and videoJobsService):
 *
 *   1. Offer expiry — an assigned trial whose countdown lapsed is expired and
 *      the worker is bounced back to `pending_trial` (re-assignable by ops).
 *   2. Feedback SLA — remind the customer at the 30-min mark, and flag ops if
 *      feedback is still missing after FEEDBACK_OVERDUE_HOURS.
 *
 * Also exports sendFeedbackRequest(), the single place that mints + sends a
 * feedback link (reused by the worker "complete" endpoint and the reminder).
 */

const TrialJob = require('../models/TrialJob');
const Worker = require('../models/Worker');
const { notifyWorker } = require('./notificationService');
const { sendTransactionalSms } = require('./smsService');
const { transitionWorker } = require('./workerStatusService');
const tokenService = require('./trialTokenService');
const {
  TRIAL_ENABLED,
  SWEEP_INTERVAL_SECONDS,
  FEEDBACK_OVERDUE_HOURS,
} = require('../config/trialConfig');

/**
 * Ask the trial host to rate the job. Called once when the worker completes, and
 * again by the SLA reminder below.
 *
 * Two shapes, depending on who the host is:
 *
 *   ADMIN-assigned — the host has no Kaaryo account, so they get a signed
 *   single-use link by SMS. Unchanged.
 *
 *   CUSTOMER-booked — the host IS a logged-in account with the form built into
 *   the app, so no token link is minted. Issuing a bearer-ish URL to someone who
 *   already has a session would be a second, weaker credential for no gain. They
 *   get a socket push plus a plain SMS nudge pointing at the app.
 *
 * This is also where a customer-booked trial's payment falls due — the one place
 * that already means "the trial job is finished", so the worker's completion
 * endpoint needed no change.
 *
 * Returns the link (admin path) or null (customer path).
 */
async function sendFeedbackRequest(job, { reminder = false } = {}) {
  const prefix = reminder ? 'Reminder: please' : 'Please';

  if (job.source === 'user' && job.requestedBy) {
    const userTrial = require('./userTrialService');

    // Payment becomes collectable now — the work is physically done. Idempotent,
    // so the SLA reminder re-entering here can't reset a payment in flight.
    if (userTrial.markPaymentDue(job)) await job.save();

    await userTrial
      .pushToCustomer(job, 'trial:feedback_requested', { reminder })
      .catch(() => {});
    await sendTransactionalSms(
      job.host.phone,
      `${prefix} rate your Kaaryo trial service in the app — it takes 1 minute.`
    ).catch(() => {});
    console.log(`🔗 [trial-feedback] in-app form requested for job ${job._id} (user ${job.requestedBy})`);
    return null;
  }

  const token = tokenService.sign(job._id);
  const link = tokenService.buildLink(token);
  await sendTransactionalSms(
    job.host.phone,
    `${prefix} rate your Kaaryo trial service. It takes 1 minute: ${link}`
  );
  console.log(`🔗 [trial-feedback] link for job ${job._id} (host ${job.host.phone}): ${link}`);
  return link;
}

// ── 1. Offer expiry ─────────────────────────────────────────────────────────
//
// For an ADMIN-assigned trial this is terminal: the job expires and the worker
// goes back in the queue for ops to reassign.
//
// For a CUSTOMER-booked trial the offer instead ROLLS to the next candidate — the
// customer is waiting on a booking, not on one particular worker, so a single
// unresponsive candidate must not kill it. The job only becomes terminal once the
// whole queue is spent (handled inside rollToNextCandidate).
async function expireStaleOffers() {
  const due = await TrialJob.find({
    status: 'assigned',
    offerExpiresAt: { $lte: new Date() },
  }).limit(50);

  for (const job of due) {
    try {
      // Release the worker who let it lapse first, whichever path follows.
      const worker = await Worker.findById(job.worker);
      if (worker && worker.status === 'trial_assigned') {
        await transitionWorker(worker, 'pending_trial', {
          reason: 'Trial offer timed out (no response)',
          trialJob: job._id,
        });
        await notifyWorker(worker, {
          title: 'Trial offer expired',
          message: 'Your trial job offer timed out. You are back in the queue for a new one.',
        }).catch(() => {});
      }

      if (job.source === 'user' && job.candidates.length) {
        // Reassigns `worker` + restarts the countdown, or ends the search.
        await require('./userTrialService').rollToNextCandidate(job, 'timeout');
        continue;
      }

      job.status = 'expired';
      job.declinedReason = 'timeout';
      job.declinedAt = new Date();
      await job.save();
    } catch (err) {
      console.error(`[trial-sweep] expire failed for job ${job._id}:`, err.message);
    }
  }
}

// ── 2. Feedback SLA (reminder + overdue flag) ────────────────────────────────
async function nudgeFeedback() {
  const now = new Date();

  // 2a. 30-min reminder: completed, no feedback yet, past SLA, not yet reminded.
  const needReminder = await TrialJob.find({
    status: 'completed',
    'feedback.decision': null,
    'feedback.submittedAt': null,
    'feedback.reminderSentAt': null,
    'feedback.slaDeadlineAt': { $lte: now },
  }).limit(50);

  for (const job of needReminder) {
    try {
      await sendFeedbackRequest(job, { reminder: true });
      job.feedback.reminderSentAt = now;
      await job.save();
    } catch (err) {
      console.error(`[trial-sweep] reminder failed for job ${job._id}:`, err.message);
    }
  }

  // 2b. Overdue: still no feedback well past completion → flag ops (+ reassure
  // the worker once so they're not left wondering in `trial_completed` limbo).
  const overdueCutoff = new Date(now.getTime() - FEEDBACK_OVERDUE_HOURS * 60 * 60 * 1000);
  const overdue = await TrialJob.find({
    status: 'completed',
    'feedback.decision': null,
    'feedback.submittedAt': null,
    'feedback.overdueAlerted': { $ne: true },
    completedAt: { $lte: overdueCutoff },
  }).limit(50);

  for (const job of overdue) {
    try {
      const msg = `⏰ Trial feedback overdue (>${FEEDBACK_OVERDUE_HOURS}h): job ${job._id} (worker ${job.worker})`;
      console.warn(msg);
      const hook = process.env.SLACK_WEBHOOK_URL;
      if (hook && typeof fetch === 'function') {
        await fetch(hook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: msg }),
        }).catch((e) => console.error(`[trial-sla] Slack webhook failed: ${e.message}`));
      }
      job.feedback.overdueAlerted = true;
      await job.save();

      const worker = await Worker.findById(job.worker);
      if (worker && worker.status === 'trial_completed') {
        await notifyWorker(worker, {
          title: 'Your trial is still being reviewed',
          message: "Thanks for your patience — we're finalising your trial review and will update you shortly.",
        }).catch(() => {});
      }
    } catch (err) {
      console.error(`[trial-sweep] overdue flag failed for job ${job._id}:`, err.message);
    }
  }
}

// ── Sweeper wiring ────────────────────────────────────────────────────────────
let sweeperTimer = null;
let sweeping = false;

async function sweepOnce() {
  if (sweeping) return; // avoid overlapping runs
  sweeping = true;
  try {
    await expireStaleOffers();
    await nudgeFeedback();
  } catch (err) {
    console.error('[trial-sweep] error:', err.message);
  } finally {
    sweeping = false;
  }
}

function startSweeper() {
  if (!TRIAL_ENABLED) {
    console.log('🧪 Trial jobs disabled (set TRIAL_ENABLED=true to enable)');
    return;
  }
  if (sweeperTimer) return;
  sweeperTimer = setInterval(sweepOnce, SWEEP_INTERVAL_SECONDS * 1000);
  if (sweeperTimer.unref) sweeperTimer.unref();
  console.log(`🧪 Trial sweeper running every ${SWEEP_INTERVAL_SECONDS}s (offer expiry + feedback SLA)`);
}

function stopSweeper() {
  if (sweeperTimer) clearInterval(sweeperTimer);
  sweeperTimer = null;
}

module.exports = { sendFeedbackRequest, expireStaleOffers, nudgeFeedback, sweepOnce, startSweeper, stopSweeper };
