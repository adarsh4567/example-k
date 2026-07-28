/**
 * Every notification the assessment filter sends, in one place (PART 7 of the
 * implementation guide). Copy lives here rather than scattered through the
 * controllers so it can be reviewed and reworded in one pass.
 *
 * Channels:
 *   worker      → push + SMS via notificationService.notifyWorker (mocked)
 *   shop owner  → SMS always, plus WhatsApp when their feedbackChannel allows
 *   ops/admin   → console + optional Slack webhook (same as trialJobsService;
 *                 there is no in-app admin notification store in this codebase)
 *
 * Every function here is best-effort: notification failures must never fail the
 * request that triggered them, so callers .catch() and this module logs.
 */

const { notifyWorker } = require('./notificationService');
const { sendTransactionalSms } = require('./smsService');
const { sendWhatsapp } = require('./whatsappService');
const emitter = require('../realtime/emitter');
const { formatDateTime } = require('../utils/slotTime');

/**
 * Nudge the worker app that the assessment record changed.
 *
 * Emitted to `worker:<id>` — the same room the socket joins on connect and the
 * same one that already delivers `jobs:open` / `job:offer`, which is the bug the
 * trial flow hit when events went somewhere else.
 *
 * `worker:status_changed` is already emitted by workerStatusService on every
 * status transition. This covers changes that the app cares about, and the
 * payload is deliberately minimal: the app re-reads
 * GET /api/worker/assessment/status rather than trusting what arrives here, so
 * both event names are sent and neither needs a stable shape.
 */
function pushAssessmentUpdate(workerId, assessment, event = 'assessment:updated') {
  const payload = assessment
    ? { assessmentId: String(assessment._id), status: assessment.status }
    : {};
  emitter.emitToWorker(workerId, event, payload);
  // Alias — the app accepts either name.
  if (event === 'assessment:updated') {
    emitter.emitToWorker(workerId, 'assessment:status_changed', payload);
  }
}

// ── Shop owner fan-out ──────────────────────────────────────────────────────
async function notifyPartner(partner, message, { template = null } = {}) {
  const channel = partner.feedbackChannel || 'both';
  const jobs = [];
  if (channel === 'sms' || channel === 'both') {
    jobs.push(sendTransactionalSms(partner.ownerPhone, message));
  }
  if (channel === 'whatsapp' || channel === 'both') {
    jobs.push(sendWhatsapp(partner.ownerPhone, message, { template }));
  }
  const results = await Promise.allSettled(jobs);
  results
    .filter((r) => r.status === 'rejected')
    .forEach((r) => console.error('[assessment-notify] partner channel failed:', r.reason && r.reason.message));
  return { sent: results.some((r) => r.status === 'fulfilled') };
}

// ── Ops alerts ──────────────────────────────────────────────────────────────
async function opsAlert(message) {
  console.warn(`🔔 [assessment-ops] ${message}`);
  const hook = process.env.SLACK_WEBHOOK_URL;
  if (hook && typeof fetch === 'function') {
    await fetch(hook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message }),
    }).catch((e) => console.error(`[assessment-ops] Slack webhook failed: ${e.message}`));
  }
}

// ── Booking ─────────────────────────────────────────────────────────────────
async function bookingConfirmed({ worker, partner, assessment, feedbackLink }) {
  const when = formatDateTime(assessment.scheduledAt);
  const maps = partner.googleMapsLink ? ` Google Maps: ${partner.googleMapsLink}` : '';

  await Promise.allSettled([
    notifyWorker(worker, {
      title: 'Assessment booked ✅',
      message: `Your assessment at ${partner.shopName} is booked for ${when}. Address: ${partner.fullAddress}.${maps}`,
    }),
    notifyPartner(
      partner,
      `A Kaaryo worker named ${worker.fullName || 'a worker'} has been scheduled for a skill assessment at your shop on ${when}. ` +
        `View details and submit feedback after the session: ${feedbackLink}`,
      { template: 'assessment_booked' }
    ),
    opsAlert(
      `New assessment booked — worker ${worker.fullName || worker.phone} at ${partner.shopName} (${partner.city}) on ${when}.`
    ),
  ]);
}

async function bookingCancelled({ worker, partner, assessment, reason }) {
  const when = formatDateTime(assessment.scheduledAt);
  await Promise.allSettled([
    notifyPartner(
      partner,
      `The Kaaryo assessment scheduled at your shop for ${when} has been cancelled by the worker. No action is needed from you.`,
      { template: 'assessment_cancelled' }
    ),
    opsAlert(
      `Assessment cancelled — worker ${worker.fullName || worker.phone} at ${partner.shopName}, was due ${when}. Reason: ${reason}`
    ),
  ]);
}

// Slot withdrawn by ops (partner terminated, or the slot itself deleted).
async function slotWithdrawn({ worker, partner, assessment }) {
  const when = formatDateTime(assessment.scheduledAt);
  await notifyWorker(worker, {
    title: 'Please rebook your assessment',
    message: `Your assessment at ${partner.shopName} on ${when} is no longer available. Please open the app and pick a new slot — we're sorry for the inconvenience.`,
  }).catch(() => {});
}

// ── Check-in ────────────────────────────────────────────────────────────────
async function workerCheckedIn({ worker, partner }) {
  await notifyPartner(
    partner,
    `${worker.fullName || 'The Kaaryo worker'} has just checked in at your shop. Please begin the skill assessment. The session should take about 45 minutes.`,
    { template: 'assessment_checked_in' }
  );
}

// ── Feedback ────────────────────────────────────────────────────────────────
async function feedbackReceived({ worker, partner, assessment, scoreSummary }) {
  await Promise.allSettled([
    notifyWorker(worker, {
      title: 'Assessment feedback received',
      message: 'Your assessment feedback has been received. We are reviewing it now and you will hear back within 24 hours.',
    }),
    opsAlert(
      `Feedback submitted for ${worker.fullName || worker.phone} (assessment ${assessment._id}) by ${partner.shopName}. ${scoreSummary}. Review now.`
    ),
  ]);
}

async function feedbackReminder({ partner, worker, feedbackLink }) {
  await notifyPartner(
    partner,
    `Reminder: please submit your assessment feedback for ${worker.fullName || 'the Kaaryo worker'}. It takes 3 minutes: ${feedbackLink}`,
    { template: 'assessment_feedback_reminder' }
  );
}

// ── No-show ─────────────────────────────────────────────────────────────────
async function noShow({ worker, partner, assessment, suspendedUntil, noShowCount }) {
  const when = formatDateTime(assessment.scheduledAt);
  const suffix = suspendedUntil
    ? ` Because you have now missed ${noShowCount} appointments, booking is paused until ${formatDateTime(suspendedUntil)}.`
    : ' Please rebook as soon as possible. Repeated no-shows may affect your application.';

  await Promise.allSettled([
    notifyWorker(worker, {
      title: 'You missed your assessment',
      message: `You missed your assessment at ${partner.shopName} on ${when}.${suffix}`,
    }),
    opsAlert(
      `No-show recorded — worker ${worker.fullName || worker.phone} at ${partner.shopName}, slot ${when}.` +
        (suspendedUntil ? ' Worker booking is now SUSPENDED.' : '')
    ),
  ]);
}

// ── Final decision ──────────────────────────────────────────────────────────
async function decisionApproved({ worker }) {
  await notifyWorker(worker, {
    title: 'Congratulations! 🎉',
    message:
      'You have passed your skill assessment and are now a Kaaryo Verified Electrician. Open the app to see your certificate and continue your application.',
  }).catch(() => {});
}

async function decisionRejected({ worker, reapplyAllowedAt }) {
  const when = reapplyAllowedAt ? formatDateTime(reapplyAllowedAt) : 'in 30 days';
  await notifyWorker(worker, {
    title: 'Thank you for completing your assessment',
    message:
      'After reviewing the feedback, we are unable to move forward with your application at this time. ' +
      `You are welcome to reapply after ${when}.`,
  }).catch(() => {});
}

// ── Payouts ─────────────────────────────────────────────────────────────────
async function upfrontPaid({ partner, amount }) {
  await notifyPartner(
    partner,
    `Thank you for submitting your assessment feedback. Your payment of ₹${amount} has been processed.`,
    { template: 'assessment_upfront_paid' }
  );
}

async function deferredPaid({ partner, amount }) {
  await notifyPartner(
    partner,
    `A worker you assessed has completed 10 jobs on Kaaryo. Your remaining payment of ₹${amount} has been processed to your account.`,
    { template: 'assessment_deferred_paid' }
  );
}

// ── Partner quality ─────────────────────────────────────────────────────────
async function partnerAutoActioned({ partner, action, score }) {
  await opsAlert(
    `Partner ${partner.shopName} (${partner.city}) auto-${action} — quality score ${score}. Review the partner dashboard.`
  );
}

module.exports = {
  notifyPartner,
  opsAlert,
  pushAssessmentUpdate,
  bookingConfirmed,
  bookingCancelled,
  slotWithdrawn,
  workerCheckedIn,
  feedbackReceived,
  feedbackReminder,
  noShow,
  decisionApproved,
  decisionRejected,
  upfrontPaid,
  deferredPaid,
  partnerAutoActioned,
};
