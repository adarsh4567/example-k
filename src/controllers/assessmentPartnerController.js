const WorkerAssessment = require('../models/WorkerAssessment');
const ShopPartner = require('../models/ShopPartner');
const Worker = require('../models/Worker');
const { ok, fail } = require('../utils/response');
const tokenService = require('../services/assessmentTokenService');
const { PUBLIC_FIELDS } = require('../config/assessmentQuestions');
const { applyFeedback } = require('../services/assessmentFeedbackService');
const booking = require('../services/assessmentBookingService');
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

    // All the scoring, counters, transitions, notifications and the payout live in
    // the service so the admin panel's equivalent flow behaves identically.
    const outcome = await applyFeedback({
      assessment,
      partner,
      worker,
      body,
      submittedVia: body.submittedVia === 'whatsapp' ? 'whatsapp' : 'web_form',
    });
    if (!outcome.ok) return fail(res, outcome.message, outcome.code, outcome.extra || {});

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
