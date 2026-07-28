/**
 * Background maintenance for the shop-assessment filter. Two cadences, both built
 * on setInterval to match dispatchService / videoJobsService / trialJobsService
 * (the guide suggests node-cron; the repo already has a sweeper idiom, and using
 * it avoids a dependency and keeps all four schedulers looking alike).
 *
 * FAST sweep (SWEEP_INTERVAL_SECONDS, default 60s):
 *   1. No-show detection — a booking whose check-in window closed with no arrival.
 *      The shop owner can mark a no-show themselves; this catches the ones where
 *      nobody touched anything, so records don't sit in `booked` forever.
 *   2. Feedback SLA — re-send the form link if the owner hasn't submitted, then
 *      flag ops if it is still missing well past the session.
 *
 * SLOW sweep (DAILY_SWEEP_INTERVAL_SECONDS, default 1h):
 *   3. Deferred payouts — release the ₹200 half once an approved worker has
 *      completed DEFERRED_PAYMENT_JOB_THRESHOLD jobs.
 *   4. Partner quality scores — monthly, idempotent (partnerQualityService only
 *      does work once per partner per month, so an hourly tick is harmless).
 *
 * Every task is idempotent and batch-limited, so an overlapping or restarted
 * sweep cannot double-pay or double-notify.
 */

const WorkerAssessment = require('../models/WorkerAssessment');
const ShopPartner = require('../models/ShopPartner');
const Worker = require('../models/Worker');
const booking = require('./assessmentBookingService');
const notify = require('./assessmentNotifyService');
const tokenService = require('./assessmentTokenService');
const partnerQuality = require('./partnerQualityService');
const { sendPayout } = require('./payoutService');
const {
  ASSESSMENT_ENABLED,
  SWEEP_INTERVAL_SECONDS,
  DAILY_SWEEP_INTERVAL_SECONDS,
  CHECKIN_CLOSES_MINUTES_AFTER,
  FEEDBACK_OVERDUE_HOURS,
  DEFERRED_PAYMENT_JOB_THRESHOLD,
} = require('../config/assessmentConfig');

const BATCH = 50;

// ── 1. No-show detection ────────────────────────────────────────────────────
async function detectNoShows() {
  // The check-in window has closed and the worker never arrived.
  const cutoff = new Date(Date.now() - CHECKIN_CLOSES_MINUTES_AFTER * 60 * 1000);
  const stale = await WorkerAssessment.find({
    status: { $in: ['booked', 'confirmed'] },
    workerArrivedAt: null,
    scheduledAt: { $lte: cutoff },
  }).limit(BATCH);

  for (const assessment of stale) {
    try {
      await booking.applyNoShow(assessment, { markedBy: 'system' });
      console.log(`⚡ [assessment-sweep] auto no-show for assessment ${assessment._id}`);
    } catch (err) {
      console.error(`[assessment-sweep] no-show failed for ${assessment._id}:`, err.message);
    }
  }
  return stale.length;
}

// ── 2. Feedback SLA (reminder + overdue flag) ───────────────────────────────
async function nudgeFeedback() {
  const now = new Date();

  // 2a. Reminder: worker attended, no feedback yet, past the SLA, not yet nudged.
  const needReminder = await WorkerAssessment.find({
    status: 'worker_arrived',
    'feedback.submittedAt': null,
    'feedback.reminderSentAt': null,
    'feedback.slaDeadlineAt': { $lte: now, $ne: null },
  }).limit(BATCH);

  for (const assessment of needReminder) {
    try {
      const [partner, worker] = await Promise.all([
        ShopPartner.findById(assessment.shopPartner),
        Worker.findById(assessment.worker),
      ]);
      if (!partner || !worker) continue;

      const link = tokenService.buildLink(
        tokenService.sign(assessment._id, assessment.scheduledEndAt)
      );
      await notify.feedbackReminder({ partner, worker, feedbackLink: link });

      assessment.feedback.reminderSentAt = now;
      await assessment.save();
    } catch (err) {
      console.error(`[assessment-sweep] reminder failed for ${assessment._id}:`, err.message);
    }
  }

  // 2b. Overdue: still nothing well after the session → flag ops, and reassure
  // the worker once so they aren't left wondering.
  const overdueCutoff = new Date(now.getTime() - FEEDBACK_OVERDUE_HOURS * 60 * 60 * 1000);
  const overdue = await WorkerAssessment.find({
    status: 'worker_arrived',
    'feedback.submittedAt': null,
    'feedback.overdueAlerted': { $ne: true },
    workerArrivedAt: { $lte: overdueCutoff, $ne: null },
  }).limit(BATCH);

  for (const assessment of overdue) {
    try {
      const partner = await ShopPartner.findById(assessment.shopPartner);
      await notify.opsAlert(
        `⏰ Assessment feedback overdue (>${FEEDBACK_OVERDUE_HOURS}h): assessment ${assessment._id} ` +
          `at ${partner ? partner.shopName : 'unknown shop'} (worker ${assessment.worker}).`
      );
      assessment.feedback.overdueAlerted = true;
      await assessment.save();
    } catch (err) {
      console.error(`[assessment-sweep] overdue flag failed for ${assessment._id}:`, err.message);
    }
  }

  return { reminded: needReminder.length, flagged: overdue.length };
}

// ── 3. Deferred payouts ─────────────────────────────────────────────────────
async function processDeferredPayments() {
  // Only approved assessments earn the deferred half, and only once the upfront
  // half actually went out.
  const candidates = await WorkerAssessment.find({
    finalDecision: 'approved',
    'payment.upfrontPaid': true,
    'payment.deferredPaid': false,
  }).limit(BATCH);

  let paid = 0;
  for (const assessment of candidates) {
    try {
      const worker = await Worker.findById(assessment.worker).select('jobsCompleted fullName');
      if (!worker) continue;
      const jobs = worker.jobsCompleted || 0;
      if (jobs < DEFERRED_PAYMENT_JOB_THRESHOLD) continue;

      const partner = await ShopPartner.findById(assessment.shopPartner);
      if (!partner) continue;

      const payout = await sendPayout(partner, {
        amount: assessment.payment.deferredAmount,
        purpose: 'assessment deferred',
        assessmentId: assessment._id,
      });

      assessment.payment.deferredPaid = true;
      assessment.payment.deferredPaidAt = new Date();
      assessment.payment.deferredReference = payout.reference;
      assessment.payment.deferredTriggerEvent = `worker completed ${jobs} jobs (threshold ${DEFERRED_PAYMENT_JOB_THRESHOLD})`;
      await assessment.save();

      await notify.deferredPaid({ partner, amount: assessment.payment.deferredAmount }).catch(() => {});
      paid += 1;
    } catch (err) {
      console.error(`[assessment-sweep] deferred payout failed for ${assessment._id}:`, err.message);
    }
  }
  if (paid) console.log(`💸 [assessment-sweep] released ${paid} deferred payout(s)`);
  return paid;
}

// ── Sweeper wiring ──────────────────────────────────────────────────────────
let fastTimer = null;
let slowTimer = null;
let fastRunning = false;
let slowRunning = false;

async function sweepOnce() {
  if (fastRunning) return; // avoid overlapping runs
  fastRunning = true;
  try {
    await detectNoShows();
    await nudgeFeedback();
  } catch (err) {
    console.error('[assessment-sweep] error:', err.message);
  } finally {
    fastRunning = false;
  }
}

async function sweepDailyOnce() {
  if (slowRunning) return;
  slowRunning = true;
  try {
    await processDeferredPayments();
    await partnerQuality.runMonthly();
  } catch (err) {
    console.error('[assessment-daily-sweep] error:', err.message);
  } finally {
    slowRunning = false;
  }
}

function startSweeper() {
  if (!ASSESSMENT_ENABLED) {
    console.log('⚡ Shop assessments disabled (set ASSESSMENT_ENABLED=true to enable)');
    return;
  }
  if (fastTimer) return;

  fastTimer = setInterval(sweepOnce, SWEEP_INTERVAL_SECONDS * 1000);
  slowTimer = setInterval(sweepDailyOnce, DAILY_SWEEP_INTERVAL_SECONDS * 1000);
  if (fastTimer.unref) fastTimer.unref();
  if (slowTimer.unref) slowTimer.unref();

  console.log(
    `⚡ Assessment sweeper running every ${SWEEP_INTERVAL_SECONDS}s (no-show + feedback SLA) · ` +
      `slow tasks every ${DAILY_SWEEP_INTERVAL_SECONDS}s (deferred payouts + partner quality)`
  );
}

function stopSweeper() {
  if (fastTimer) clearInterval(fastTimer);
  if (slowTimer) clearInterval(slowTimer);
  fastTimer = null;
  slowTimer = null;
}

module.exports = {
  detectNoShows,
  nudgeFeedback,
  processDeferredPayments,
  sweepOnce,
  sweepDailyOnce,
  startSweeper,
  stopSweeper,
};
