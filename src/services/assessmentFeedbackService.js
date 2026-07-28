/**
 * Landing a shop-owner feedback submission — the single implementation shared by
 * the token-authenticated partner form and the admin panel's "submit on behalf of
 * the shop owner" flow.
 *
 * It exists as a service because that submission is not one write: it scores the
 * answers, advances the assessment, bumps the partner's counters, moves the worker
 * into the review queue, pushes the app off its waiting screen, notifies ops, and
 * releases the upfront payout. Duplicating that for the admin path would guarantee
 * the two drift.
 *
 * The score NEVER auto-decides — every assessment still gets an explicit admin
 * decision. See services/assessmentScoreService.
 */

const { validateSubmission } = require('../config/assessmentQuestions');
const { score, summarise } = require('./assessmentScoreService');
const { transitionWorker } = require('./workerStatusService');
const notify = require('./assessmentNotifyService');
const { sendPayout } = require('./payoutService');

// Statuses from which feedback may be submitted: the worker must have arrived.
const FEEDBACK_READY_STATUSES = ['worker_arrived', 'assessment_complete'];

/**
 * @param {object} args
 *   assessment, partner, worker — Mongoose documents
 *   body        — the raw submission (validated here)
 *   submittedVia — 'web_form' | 'whatsapp' | 'admin'
 *   adminId     — set when an admin submitted on the owner's behalf
 * @returns {{ok:true, result, assessment} | {ok:false, code, message, extra?}}
 */
async function applyFeedback({ assessment, partner, worker, body, submittedVia, adminId = null }) {
  if (assessment.feedback && assessment.feedback.submittedAt) {
    return { ok: false, code: 409, message: 'Feedback has already been submitted for this assessment' };
  }
  if (['cancelled', 'no_show'].includes(assessment.status)) {
    return { ok: false, code: 409, message: `This assessment was marked ${assessment.status} and is closed` };
  }
  // The geofenced check-in is what proves the worker actually attended. If they
  // never arrived, the correct action is mark-no-show, which pays nothing.
  if (!FEEDBACK_READY_STATUSES.includes(assessment.status)) {
    return {
      ok: false,
      code: 409,
      message:
        'The worker has not checked in for this assessment yet. If they did not arrive, use the "mark as no-show" option instead.',
      extra: { status: assessment.status },
    };
  }

  const validated = validateSubmission(body);
  if (!validated.ok) return { ok: false, code: 422, message: validated.message };

  const result = score(validated.value);
  const now = new Date();

  Object.assign(assessment.feedback, validated.value, {
    preliminaryScore: result.preliminaryScore,
    safetyFailed: result.safetyFailed,
    engineRecommendation: result.recommendation,
    scoreBreakdown: result.breakdown,
    submittedVia,
    submittedByAdmin: adminId,
    submittedAt: now,
  });
  // The session is complete by definition once the owner has reviewed it.
  assessment.assessmentCompletedAt = assessment.assessmentCompletedAt || now;
  assessment.feedbackSubmittedAt = now;
  assessment.status = 'feedback_submitted';
  await assessment.save();

  // Partner counters (feed the approval-rate column and the quality score).
  partner.stats.totalAssessmentsConducted = (partner.stats.totalAssessmentsConducted || 0) + 1;
  partner.stats.lastAssessmentAt = now;
  await partner.save();

  // Worker moves into the admin review queue.
  if (['assessment_checked_in', 'assessment_booked'].includes(worker.status)) {
    await transitionWorker(worker, 'assessment_feedback_submitted', {
      actor: adminId ? 'admin' : 'system',
      reason: `Shop feedback submitted by ${partner.shopName} — ${summarise(result)}`,
      assessment: assessment._id,
    });
  }
  worker.electricalAssessment.stage = 'awaiting_decision';
  await worker.save();

  // Push the app off the "waiting for the shop owner" screen straight away.
  notify.pushAssessmentUpdate(worker._id, assessment);

  await notify
    .feedbackReceived({ worker, partner, assessment, scoreSummary: summarise(result) })
    .catch((e) => console.error('[assessment] feedback notifications failed:', e.message));

  // Release the upfront half. Non-fatal: a payout failure must not lose the
  // feedback that was just submitted — ops can retry from the payments dashboard.
  try {
    const payout = await sendPayout(partner, {
      amount: assessment.payment.upfrontAmount,
      purpose: 'assessment upfront',
      assessmentId: assessment._id,
    });
    assessment.payment.upfrontPaid = true;
    assessment.payment.upfrontPaidAt = new Date();
    assessment.payment.upfrontReference = payout.reference;
    await assessment.save();
    await notify.upfrontPaid({ partner, amount: assessment.payment.upfrontAmount }).catch(() => {});
  } catch (e) {
    console.error(`[assessment] upfront payout failed for ${assessment._id}:`, e.message);
    await notify
      .opsAlert(`Upfront payout FAILED for assessment ${assessment._id} (${partner.shopName}): ${e.message}`)
      .catch(() => {});
  }

  return { ok: true, result, assessment };
}

module.exports = { applyFeedback, FEEDBACK_READY_STATUSES };
