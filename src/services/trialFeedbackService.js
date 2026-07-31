const Worker = require('../models/Worker');
const { TRIAL_QUESTIONS, isValidAnswer } = require('../config/trialQuestions');
const { decide, outcomeStatusFor } = require('./trialDecisionService');
const { transitionWorker } = require('./workerStatusService');
const { settleApprovedTrial } = require('./trialSettlementService');
const { notifyWorker } = require('./notificationService');

/**
 * Recording trial feedback and, through it, onboarding the worker.
 *
 * Extracted from trialFeedbackController because there are now two ways feedback
 * arrives and they must be indistinguishable in effect:
 *
 *   • the tokenised public form  — admin-assigned trials, where the host has no
 *     account (`submittedVia: 'sms_link'`)
 *   • the in-app form            — customer-booked trials, submitted by the
 *     logged-in account that booked it (`submittedVia: 'user_app'`)
 *
 * The consequences of feedback — run the decision engine, transition the worker,
 * settle an approved trial into their earnings, notify them — are identical and
 * far too important to have two copies of. A drift here would mean a worker who
 * passes on one route and stays stuck on the other.
 */

// Public shape of the questions (drops internal flags like positive/hardFail —
// the client must not be able to see which answer is the "right" one).
const PUBLIC_QUESTIONS = TRIAL_QUESTIONS.map((q) => ({
  key: q.key,
  prompt: q.prompt,
  type: q.type,
  optional: !!q.optional,
  options: (q.options || []).map((o) => ({ value: o.value, label: o.label })),
}));

/**
 * Validate a raw answers object against the question set.
 * @returns {{ok:true, answers}} | {{ok:false, reason}}
 */
function validateAnswers(raw = {}) {
  const answers = {};
  for (const q of TRIAL_QUESTIONS) {
    const val = raw[q.key];
    if (val === undefined || val === null || val === '') {
      if (q.optional) continue;
      return { ok: false, reason: `Missing answer for ${q.key}: "${q.prompt}"` };
    }
    if (!isValidAnswer(q.key, val)) {
      return { ok: false, reason: `Invalid answer "${val}" for ${q.key}` };
    }
    answers[q.key] = String(val);
  }
  return { ok: true, answers };
}

/**
 * Is this trial job ready to receive feedback?
 * @returns {{ok:true}} | {{ok:false, code, reason}}
 */
function checkFeedbackOpen(job) {
  if (job.feedback && job.feedback.submittedAt) {
    return { ok: false, code: 409, reason: 'Feedback has already been submitted for this trial' };
  }
  if (job.status !== 'completed') {
    return { ok: false, code: 409, reason: 'This trial is not yet ready for feedback' };
  }
  return { ok: true };
}

/**
 * Record answers, run the decision engine, and apply the outcome to the worker.
 *
 * strong_pass → approved (+ settled into their earnings), fail → rejected, and
 * conditional is left for a human — the worker stays in `trial_completed` and
 * shows up in the admin queue. That three-way split is the whole point of the
 * filter, so the caller does not get to choose it.
 *
 * @param {Document} job     a TrialJob (mutated + saved)
 * @param {object} answers   already validated by validateAnswers()
 * @param {'sms_link'|'user_app'|'admin'} via
 * @returns {Promise<{decision, autoFinalized, workerStatus, workerName}>}
 */
async function recordFeedback(job, answers, via = 'sms_link') {
  const verdict = decide(answers);

  job.feedback.answers = answers;
  job.feedback.decision = verdict;
  job.feedback.submittedVia = via;
  job.feedback.submittedAt = new Date();
  await job.save();

  const targetStatus = outcomeStatusFor(verdict);
  let workerStatus = null;
  let workerName = null;

  const worker = await Worker.findById(job.worker);
  if (worker) {
    workerName = worker.fullName;
    workerStatus = worker.status;

    // Only act on a worker actually awaiting this verdict. Anything else means
    // the trial was already resolved another way (an admin decision, say) and
    // re-driving the transition would rewrite a settled outcome.
    if (targetStatus && worker.status === 'trial_completed') {
      await transitionWorker(worker, targetStatus, {
        reason: `Trial decision engine: ${verdict}`,
        trialJob: job._id,
      });
      workerStatus = worker.status;

      // On approval, credit the trial into the worker's dashboard (wallet + jobs
      // done + history). Idempotent via TrialJob.settledAt.
      if (targetStatus === 'approved') {
        await settleApprovedTrial(job, worker).catch((e) =>
          console.error('[trial] settlement failed:', e.message)
        );
      }

      await notifyWorker(worker, {
        title: targetStatus === 'approved' ? "You're approved! 🎉" : 'Trial review update',
        message:
          targetStatus === 'approved'
            ? 'Your trial passed. You can now start accepting jobs on Kaaryo.'
            : 'Thank you for completing your trial. Unfortunately it was not approved this time.',
      }).catch(() => {});
    }
  }

  return { decision: verdict, autoFinalized: !!targetStatus, workerStatus, workerName };
}

module.exports = { PUBLIC_QUESTIONS, validateAnswers, checkFeedbackOpen, recordFeedback };
