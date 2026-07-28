const WorkerAssessment = require('../models/WorkerAssessment');
const ShopPartner = require('../models/ShopPartner');
const Worker = require('../models/Worker');
const { ok, fail } = require('../utils/response');
const tokenService = require('../services/assessmentTokenService');
const { validateSubmission, PUBLIC_FIELDS } = require('../config/assessmentQuestions');
const { score, summarise } = require('../services/assessmentScoreService');
const { transitionWorker } = require('../services/workerStatusService');
const booking = require('../services/assessmentBookingService');
const notify = require('../services/assessmentNotifyService');
const { sendPayout } = require('../services/payoutService');
const { formatDateTime } = require('../utils/slotTime');
const { NO_SHOW_GRACE_MINUTES } = require('../config/assessmentConfig');

/**
 * The shop owner has no account. Every endpoint here is authenticated purely by
 * the signed token in the link that was SMS'd / WhatsApp'd to them at booking
 * time (see services/assessmentTokenService). The token is scoped to one
 * assessment and expires 24h after the slot ends.
 */

// Resolve a token → assessment (+ partner + worker). Writes the failure response
// and returns null when the token or the assessment state is unusable.
async function resolveAssessment(token, res, { requireOpen = true } = {}) {
  if (!token) {
    fail(res, 'assessmentToken is required', 422);
    return null;
  }

  const v = tokenService.verify(token);
  if (!v.ok) {
    fail(res, v.reason, 401);
    return null;
  }

  const assessment = await WorkerAssessment.findById(v.assessmentId);
  if (!assessment) {
    fail(res, 'Assessment not found', 404);
    return null;
  }

  if (requireOpen) {
    if (assessment.feedback && assessment.feedback.submittedAt) {
      fail(res, 'Feedback has already been submitted for this assessment', 409);
      return null;
    }
    if (['cancelled', 'no_show'].includes(assessment.status)) {
      fail(res, `This assessment was marked ${assessment.status} and is closed`, 409);
      return null;
    }
  }

  const [partner, worker] = await Promise.all([
    ShopPartner.findById(assessment.shopPartner),
    Worker.findById(assessment.worker),
  ]);
  if (!partner || !worker) {
    fail(res, 'This assessment is no longer available', 404);
    return null;
  }

  return { assessment, partner, worker };
}

// GET /api/partner/assessment/form/:token
// Page 1 of the web form: confirm the worker + slot, then render pages 2-4 from
// the returned field list (so form copy is never hard-coded in the front end).
async function getForm(req, res, next) {
  try {
    const ctx = await resolveAssessment(req.params.token, res);
    if (!ctx) return;
    const { assessment, partner, worker } = ctx;

    return ok(
      res,
      {
        assessment: {
          id: assessment._id,
          status: assessment.status,
          workerName: worker.fullName || 'the worker',
          workerPhone: worker.phone,
          scheduledAt: assessment.scheduledAt,
          scheduledFor: formatDateTime(assessment.scheduledAt),
          workerArrivedAt: assessment.workerArrivedAt,
          checkedIn: !!assessment.workerArrivedAt,
        },
        shop: { shopName: partner.shopName, ownerName: partner.ownerName },
        fields: PUBLIC_FIELDS,
        payment: {
          amountOnSubmit: assessment.payment.upfrontAmount,
          note: `Your payment of ₹${assessment.payment.upfrontAmount} will be processed within 24 hours of submitting this form.`,
        },
        // Only offerable once the grace period after the slot start has elapsed.
        canMarkNoShow:
          !assessment.workerArrivedAt &&
          Date.now() >= assessment.scheduledAt.getTime() + NO_SHOW_GRACE_MINUTES * 60 * 1000,
        noShowGraceMinutes: NO_SHOW_GRACE_MINUTES,
      },
      'Assessment feedback form'
    );
  } catch (err) {
    next(err);
  }
}

// POST /api/partner/assessment/submit-feedback
// body: { assessmentToken, isolatedCircuitBeforeTouching, toolHandlingScore,
//         repairQualityScore, askedSensibleQuestions, overallRecommendation,
//         wouldHireInShop, tasksPerformed, additionalNotes? }
// (the token may also come from the path when posting to /form/:token)
async function submitFeedback(req, res, next) {
  try {
    const body = req.body || {};
    const token = body.assessmentToken || req.params.token;

    const ctx = await resolveAssessment(token, res);
    if (!ctx) return;
    const { assessment, partner, worker } = ctx;

    // The worker must have checked in — that geofenced check-in is what proves
    // they actually attended. If they never arrived, the correct action is
    // mark-no-show, which pays nothing.
    if (!['worker_arrived', 'assessment_complete'].includes(assessment.status)) {
      return fail(
        res,
        'The worker has not checked in for this assessment yet. If they did not arrive, use the "mark as no-show" option instead.',
        409,
        { status: assessment.status }
      );
    }

    const validated = validateSubmission(body);
    if (!validated.ok) return fail(res, validated.message, 422);

    const result = score(validated.value);
    const now = new Date();

    Object.assign(assessment.feedback, validated.value, {
      preliminaryScore: result.preliminaryScore,
      safetyFailed: result.safetyFailed,
      engineRecommendation: result.recommendation,
      scoreBreakdown: result.breakdown,
      submittedVia: body.submittedVia === 'whatsapp' ? 'whatsapp' : 'web_form',
      submittedAt: now,
    });
    // The session is complete by definition once the owner has reviewed it.
    assessment.assessmentCompletedAt = assessment.assessmentCompletedAt || now;
    assessment.feedbackSubmittedAt = now;
    assessment.status = 'feedback_submitted';
    await assessment.save();

    // Partner counters.
    partner.stats.totalAssessmentsConducted = (partner.stats.totalAssessmentsConducted || 0) + 1;
    partner.stats.lastAssessmentAt = now;
    await partner.save();

    // Worker moves into the admin review queue. NOTE: the score never
    // auto-decides — every assessment gets a human decision.
    if (worker.status === 'assessment_checked_in' || worker.status === 'assessment_booked') {
      await transitionWorker(worker, 'assessment_feedback_submitted', {
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

    // Release the upfront half of the payout. Non-fatal: a payout failure must
    // not lose the feedback that was just submitted — ops can retry from the
    // payments dashboard.
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
      await notify
        .upfrontPaid({ partner, amount: assessment.payment.upfrontAmount })
        .catch(() => {});
    } catch (e) {
      console.error(`[assessment] upfront payout failed for ${assessment._id}:`, e.message);
      await notify
        .opsAlert(`Upfront payout FAILED for assessment ${assessment._id} (${partner.shopName}): ${e.message}`)
        .catch(() => {});
    }

    return ok(
      res,
      {
        submitted: true,
        payment: {
          amount: assessment.payment.upfrontAmount,
          processed: assessment.payment.upfrontPaid,
        },
      },
      `Thank you. Your feedback has been recorded. Your payment of ₹${assessment.payment.upfrontAmount} will be processed within 24 hours.`
    );
  } catch (err) {
    next(err);
  }
}

// POST /api/partner/assessment/mark-no-show   { assessmentToken }
async function markNoShow(req, res, next) {
  try {
    const token = (req.body && req.body.assessmentToken) || req.params.token;

    const ctx = await resolveAssessment(token, res);
    if (!ctx) return;
    const { assessment, partner, worker } = ctx;

    if (!['booked', 'confirmed'].includes(assessment.status)) {
      return fail(
        res,
        assessment.workerArrivedAt
          ? 'This worker has already checked in, so they cannot be marked as a no-show.'
          : `This assessment cannot be marked as a no-show (status: ${assessment.status})`,
        409
      );
    }

    const markableFrom = assessment.scheduledAt.getTime() + NO_SHOW_GRACE_MINUTES * 60 * 1000;
    if (Date.now() < markableFrom) {
      return fail(
        res,
        `Please wait until ${NO_SHOW_GRACE_MINUTES} minutes after the scheduled time before marking a no-show.`,
        409,
        { canMarkFrom: new Date(markableFrom) }
      );
    }

    // Shared policy (counter, suspension, slot release, notifications) lives in
    // the booking service so the sweeper's automatic detection behaves identically.
    // Deliberately NO payout — no assessment was conducted.
    const { suspendedUntil } = await booking.applyNoShow(assessment, {
      markedBy: 'partner',
      partner,
      worker,
    });

    return ok(
      res,
      { status: assessment.status, workerSuspendedUntil: suspendedUntil },
      'Thank you for letting us know. The worker has been notified and no payment applies for a no-show.'
    );
  } catch (err) {
    next(err);
  }
}

module.exports = { getForm, submitFeedback, markNoShow };
