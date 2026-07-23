const TrialJob = require('../models/TrialJob');
const Worker = require('../models/Worker');
const { ok, fail } = require('../utils/response');
const tokenService = require('../services/trialTokenService');
const { decide, outcomeStatusFor } = require('../services/trialDecisionService');
const { transitionWorker } = require('../services/workerStatusService');
const { notifyWorker } = require('../services/notificationService');
const { TRIAL_QUESTIONS, isValidAnswer } = require('../config/trialQuestions');

// Public shape of the questions (drops internal flags like positive/hardFail).
const PUBLIC_QUESTIONS = TRIAL_QUESTIONS.map((q) => ({
  key: q.key,
  prompt: q.prompt,
  type: q.type,
  optional: !!q.optional,
  options: (q.options || []).map((o) => ({ value: o.value, label: o.label })),
}));

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
  if (job.feedback && job.feedback.submittedAt) {
    fail(res, 'Feedback has already been submitted for this trial', 409);
    return null;
  }
  if (job.status !== 'completed') {
    fail(res, 'This trial is not yet ready for feedback', 409);
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
        questions: PUBLIC_QUESTIONS,
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

    // Validate every non-optional question is answered with an allowed value.
    const answers = {};
    for (const q of TRIAL_QUESTIONS) {
      const val = raw[q.key];
      if (val === undefined || val === null || val === '') {
        if (q.optional) continue;
        return fail(res, `Missing answer for ${q.key}: "${q.prompt}"`, 422);
      }
      if (!isValidAnswer(q.key, val)) {
        return fail(res, `Invalid answer "${val}" for ${q.key}`, 422);
      }
      answers[q.key] = String(val);
    }

    const verdict = decide(answers);

    job.feedback.answers = answers;
    job.feedback.decision = verdict;
    job.feedback.submittedVia = 'sms_link';
    job.feedback.submittedAt = new Date();
    await job.save();

    // Auto-finalise strong_pass / fail; conditional waits for an admin.
    const targetStatus = outcomeStatusFor(verdict);
    if (targetStatus) {
      const worker = await Worker.findById(job.worker);
      if (worker && worker.status === 'trial_completed') {
        await transitionWorker(worker, targetStatus, {
          reason: `Trial decision engine: ${verdict}`,
          trialJob: job._id,
        });
        await notifyWorker(worker, {
          title: targetStatus === 'approved' ? "You're approved! 🎉" : 'Trial review update',
          message:
            targetStatus === 'approved'
              ? 'Your trial passed. You can now start accepting jobs on Kaaryo.'
              : 'Thank you for completing your trial. Unfortunately it was not approved this time.',
        }).catch(() => {});
      }
    }

    return ok(
      res,
      { decision: verdict, autoFinalized: !!targetStatus },
      'Thank you — your feedback has been recorded'
    );
  } catch (err) {
    next(err);
  }
}

module.exports = { getForm, submitFeedback };
