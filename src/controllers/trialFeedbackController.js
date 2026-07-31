const TrialJob = require('../models/TrialJob');
const Worker = require('../models/Worker');
const { ok, fail } = require('../utils/response');
const tokenService = require('../services/trialTokenService');
const feedbackService = require('../services/trialFeedbackService');

/**
 * The PUBLIC (tokenised) trial feedback form.
 *
 * Used for admin-assigned trials, where the host is not a Kaaryo account holder —
 * access is gated by a signed single-use link rather than a session.
 *
 * A customer who booked their own trial in the app submits the same form through
 * userTrialController instead, authenticated by their token. Both routes run the
 * identical validation → decision → onboarding path in trialFeedbackService, so
 * the outcome cannot differ between them.
 */

// Resolve a token → live, feedback-open trial job. Returns the job or null
// (having already written the failure response).
async function resolveOpenJob(token, res) {
  const v = tokenService.verify(token);
  if (!v.ok) {
    fail(res, v.reason, 400);
    return null;
  }
  const job = await TrialJob.findById(v.jobId);
  if (!job) {
    fail(res, 'Trial job not found', 404);
    return null;
  }
  const open = feedbackService.checkFeedbackOpen(job);
  if (!open.ok) {
    fail(res, open.reason, open.code);
    return null;
  }
  return job;
}

// GET /api/public/trial-feedback/:token  — render context for the form.
async function getForm(req, res, next) {
  try {
    const job = await resolveOpenJob(req.params.token, res);
    if (!job) return;

    const worker = await Worker.findById(job.worker).select('fullName');
    return ok(
      res,
      {
        job: {
          id: job._id,
          workerName: worker ? worker.fullName : 'the worker',
          category: job.category,
          subcategory: job.subcategory,
          completedAt: job.completedAt,
        },
        questions: feedbackService.PUBLIC_QUESTIONS,
      },
      'Trial feedback form'
    );
  } catch (err) {
    next(err);
  }
}

// POST /api/public/trial-feedback/:token  — submit answers, run the engine.
// body: { answers: { q1..q10 } }  (or the q1..q10 fields at top level)
async function submitFeedback(req, res, next) {
  try {
    const job = await resolveOpenJob(req.params.token, res);
    if (!job) return;

    const raw = (req.body && req.body.answers) || req.body || {};
    const parsed = feedbackService.validateAnswers(raw);
    if (!parsed.ok) return fail(res, parsed.reason, 422);

    const result = await feedbackService.recordFeedback(job, parsed.answers, 'sms_link');

    return ok(
      res,
      { decision: result.decision, autoFinalized: result.autoFinalized },
      'Thank you — your feedback has been recorded'
    );
  } catch (err) {
    next(err);
  }
}

module.exports = { getForm, submitFeedback };
