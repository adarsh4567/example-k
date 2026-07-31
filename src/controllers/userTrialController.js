const TrialJob = require('../models/TrialJob');
const { ok, fail } = require('../utils/response');
const { isValidSubcategory, categoryName, SERVICE_CATALOG } = require('../services/serviceCatalog');
const { computeTrialPrice } = require('../services/pricingService');
const userTrial = require('../services/userTrialService');
const feedbackService = require('../services/trialFeedbackService');
const gateway = require('../services/paymentGateway');
const { trialUserView, trialSummaryView } = require('../utils/trialPayload');
const { OFFER_WINDOW_SECONDS, USER_TRIAL_CATEGORY } = require('../config/trialConfig');

/**
 * The customer app's discounted trial booking.
 *
 * A trial job is the last filter in worker onboarding: a trainee does one
 * subsidised job and the customer's feedback decides whether they're approved.
 * Ops used to create these by hand. Exposing it to customers turns a manual task
 * into supply the platform can clear, and gives the customer a genuinely cheap
 * first job — they pay ₹100 on a ₹110 job and get ₹40 back.
 *
 * CLEANING ONLY. Electricians don't do a trial job at all; they sit a hands-on
 * assessment at a partner shop instead (Filter 3), so they never enter the trial
 * queue. `category` is therefore not a request parameter — it's fixed server-side
 * and a body that tries to set it is rejected rather than silently ignored.
 */

const JOB_DESCRIPTION_MAX_LENGTH = 500;

// Ownership check. A trial belonging to someone else answers 404, not 403, so ids
// can't be enumerated — same rule as the normal request endpoints.
async function loadOwnedTrial(req, res, next) {
  try {
    const job = await TrialJob.findById(req.params.id);
    if (!job || String(job.requestedBy || '') !== String(req.user._id)) {
      return fail(res, 'Trial booking not found', 404);
    }
    req.trialJob = job;
    next();
  } catch (err) {
    if (err.name === 'CastError') return fail(res, 'Trial booking not found', 404);
    next(err);
  }
}

/**
 * GET /api/user/trials/offer
 *
 * Everything the app needs to render (or hide) the "try a discounted trial" card:
 * whether this customer may book, the exact prices, and the subcategories on
 * offer. Called before showing the entry point so the customer never taps into a
 * flow that will refuse them.
 */
async function getOffer(req, res, next) {
  try {
    const eligibility = await userTrial.checkEligibility(req.user);
    const pricing = computeTrialPrice(USER_TRIAL_CATEGORY);
    const catalogEntry = SERVICE_CATALOG.find((c) => c.key === USER_TRIAL_CATEGORY);

    return ok(
      res,
      {
        available: eligibility.eligible,
        // Present whenever `available` is false, so the card can explain itself
        // instead of just vanishing.
        reason: eligibility.eligible ? null : eligibility.reason,
        code: eligibility.eligible ? null : eligibility.code,
        liveTrialId: eligibility.liveJobId || null,
        used: eligibility.used,
        allowance: eligibility.allowance,

        category: USER_TRIAL_CATEGORY,
        categoryName: categoryName(USER_TRIAL_CATEGORY),
        subcategories: catalogEntry ? catalogEntry.subcategories : [],

        pricing: {
          currency: pricing.currency,
          basePrice: pricing.basePrice,
          userPrice: pricing.userPrice,
          userSavings: pricing.userSavings,
          userDiscountPercent: pricing.userDiscountPercent,
          rewardPercent: pricing.userRewardPercent,
          rewardAmount: pricing.userReward,
          // What the customer is effectively out of pocket once the reward lands.
          netCost: Math.max(0, pricing.userPrice - pricing.userReward),
        },

        offerWindowSeconds: OFFER_WINDOW_SECONDS,
      },
      eligibility.eligible ? 'Discounted trial available' : 'Discounted trial not available'
    );
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/user/trials
 * { subcategory?, jobDescription, lat, lng, address?, scheduledTime? }
 *
 * No `category` — it is fixed to cleaning (see the header note). No name/phone
 * either: those come from the authenticated account, since the worker sees them.
 */
async function createTrial(req, res, next) {
  try {
    const user = req.user;
    const b = req.body || {};
    const { subcategory, jobDescription, lat, lng, address, scheduledTime } = b;

    // Reject an explicit wrong category rather than quietly overriding it — a
    // client asking for an electrical trial has a wrong model of the product, and
    // silently booking them a cleaning job would be worse than an error.
    if (b.category && b.category !== USER_TRIAL_CATEGORY) {
      return fail(
        res,
        `Discounted trial jobs are only available for ${categoryName(USER_TRIAL_CATEGORY)}. ` +
          `Book a regular service for ${b.category}.`,
        422,
        { code: 'TRIAL_CATEGORY_NOT_SUPPORTED', supportedCategory: USER_TRIAL_CATEGORY }
      );
    }

    if (!user.fullName || !user.fullName.trim()) {
      return fail(res, 'Please add your name to your profile before booking a service', 422, {
        code: 'PROFILE_INCOMPLETE',
      });
    }
    if (subcategory && !isValidSubcategory(USER_TRIAL_CATEGORY, subcategory)) {
      return fail(res, `Invalid subcategory "${subcategory}" for ${USER_TRIAL_CATEGORY}`, 422);
    }
    if (!jobDescription || !String(jobDescription).trim()) {
      return fail(res, 'jobDescription is required', 422);
    }
    if (String(jobDescription).trim().length > JOB_DESCRIPTION_MAX_LENGTH) {
      return fail(res, `jobDescription must be under ${JOB_DESCRIPTION_MAX_LENGTH} characters`, 422);
    }
    if (!userTrial.validCoord(Number(lat), Number(lng))) {
      return fail(res, 'Valid numeric lat and lng are required', 422);
    }

    const eligibility = await userTrial.checkEligibility(user);
    if (!eligibility.eligible) {
      // A live booking comes back in the body so the app can navigate to it
      // rather than showing a dead end.
      const live = eligibility.liveJobId ? await TrialJob.findById(eligibility.liveJobId) : null;
      return fail(res, eligibility.reason, eligibility.code === 'TRIAL_IN_PROGRESS' ? 409 : 403, {
        code: eligibility.code,
        trial: live ? await trialUserView(live) : undefined,
      });
    }

    const result = await userTrial.createTrialBooking(user, {
      subcategory,
      jobDescription,
      lat,
      lng,
      address,
      scheduledTime,
    });
    if (!result.ok) {
      return fail(res, result.reason, result.httpCode || 400, { code: result.code });
    }

    return ok(
      res,
      {
        trial: await trialUserView(result.job),
        candidateCount: result.candidateCount,
        offerWindowSeconds: OFFER_WINDOW_SECONDS,
      },
      `Trial booked — asking a nearby trainee professional to accept ` +
        `(up to ${result.candidateCount} will be tried in turn).`,
      201
    );
  } catch (err) {
    next(err);
  }
}

// GET /api/user/trials  — this customer's trial bookings
async function listTrials(req, res, next) {
  try {
    const jobs = await TrialJob.find({ requestedBy: req.user._id }).sort({ createdAt: -1 }).limit(50);
    // "Active" = still needs something from the customer, which is not the same
    // as "not finished" — a paid AND rated trial belongs in history. See
    // TrialJob.needsCustomer.
    const live = jobs.filter((j) => TrialJob.needsCustomer(j));
    const past = jobs.filter((j) => !TrialJob.needsCustomer(j));
    return ok(
      res,
      {
        active: await Promise.all(live.map((j) => trialUserView(j))),
        history: past.map(trialSummaryView),
      },
      'Your trial bookings'
    );
  } catch (err) {
    next(err);
  }
}

// GET /api/user/trials/active  — for app launch
async function activeTrial(req, res, next) {
  try {
    const job = await TrialJob.findOne(TrialJob.needsCustomerQuery(req.user._id)).sort({ createdAt: -1 });

    return ok(
      res,
      { trial: job ? await trialUserView(job) : null },
      job ? 'Active trial booking' : 'No active trial booking'
    );
  } catch (err) {
    next(err);
  }
}

// GET /api/user/trials/:id
async function getTrial(req, res, next) {
  try {
    return ok(res, { trial: await trialUserView(req.trialJob) }, 'Trial booking');
  } catch (err) {
    next(err);
  }
}

// POST /api/user/trials/:id/cancel
async function cancelTrial(req, res, next) {
  try {
    const result = await userTrial.cancelTrialBooking(req.trialJob);
    if (!result.ok) return fail(res, result.reason, result.httpCode || 400);
    return ok(res, { trial: await trialUserView(result.job) }, 'Trial booking cancelled');
  } catch (err) {
    next(err);
  }
}

// POST /api/user/trials/:id/retry  — search again after nobody accepted
async function retryTrial(req, res, next) {
  try {
    const result = await userTrial.retryTrialBooking(req.trialJob);
    if (!result.ok) return fail(res, result.reason, result.httpCode || 400, { code: result.code });
    return ok(
      res,
      { trial: await trialUserView(result.job), candidateCount: result.candidateCount },
      `Searching again — asking up to ${result.candidateCount} trainee professional(s).`
    );
  } catch (err) {
    next(err);
  }
}

// POST /api/user/trials/:id/payment/initiate  { method }
async function initiatePayment(req, res, next) {
  try {
    const { method } = req.body || {};
    const result = await userTrial.initiateTrialPayment(req.trialJob, { method });
    if (!result.ok) return fail(res, result.reason, result.httpCode || 400);

    const trial = await trialUserView(result.job);
    if (result.alreadyPaid) return ok(res, { trial }, 'This trial is already paid');

    return ok(
      res,
      {
        trial,
        payment: {
          orderId: result.payment.orderId,
          amount: result.payment.amount,
          currency: result.payment.currency,
          method: result.payment.method,
          provider: result.payment.provider,
          mode: gateway.MODE,
        },
      },
      'Payment initiated'
    );
  } catch (err) {
    next(err);
  }
}

// POST /api/user/trials/:id/payment/confirm  { orderId, gatewayReference? }
// Captures the payment and credits the customer's reward in the same call.
async function confirmPayment(req, res, next) {
  try {
    const { orderId, gatewayReference } = req.body || {};
    const result = await userTrial.confirmTrialPayment(req.trialJob, { orderId, gatewayReference });

    if (!result.ok) {
      return fail(res, result.reason, result.httpCode || 400, {
        trial: result.job ? await trialUserView(result.job) : undefined,
      });
    }

    const trial = await trialUserView(result.job);
    return ok(
      res,
      {
        trial,
        rewardCredited: result.rewarded,
        rewardAmount: trial.reward.amount,
      },
      result.alreadyPaid
        ? 'This trial is already paid'
        : `Payment successful — ₹${trial.reward.amount} reward credited to your wallet`
    );
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/user/trials/:id/feedback-form
 *
 * The 10 questions, served from the same source of truth as the public token form
 * (config/trialQuestions via trialFeedbackService). Never includes which answer
 * is the "good" one — the decision engine's thresholds stay server-side.
 */
async function getFeedbackForm(req, res, next) {
  try {
    const job = req.trialJob;
    const open = feedbackService.checkFeedbackOpen(job);
    if (!open.ok) return fail(res, open.reason, open.code);

    const view = await trialUserView(job);
    return ok(
      res,
      {
        trial: { id: job._id, category: job.category, completedAt: job.completedAt },
        worker: view.worker ? { name: view.worker.name, isTrainee: true } : null,
        questions: feedbackService.PUBLIC_QUESTIONS,
      },
      'Trial feedback form'
    );
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/user/trials/:id/feedback   { answers: { q1..q10 } }
 *
 * This is the step that ONBOARDS THE WORKER. The answers run through the same
 * decision engine as the public form: all-positive plus "would definitely book
 * again" approves them outright, any hard-fail answer rejects them, and anything
 * in between is held for a human.
 *
 * The verdict is returned but deliberately not dressed up as the customer's
 * decision — they rated a job, they didn't sit on a hiring panel.
 */
async function submitFeedback(req, res, next) {
  try {
    const job = req.trialJob;
    const open = feedbackService.checkFeedbackOpen(job);
    if (!open.ok) return fail(res, open.reason, open.code);

    const raw = (req.body && req.body.answers) || req.body || {};
    const parsed = feedbackService.validateAnswers(raw);
    if (!parsed.ok) return fail(res, parsed.reason, 422);

    const result = await feedbackService.recordFeedback(job, parsed.answers, 'user_app');

    return ok(
      res,
      {
        trial: await trialUserView(job),
        // For the thank-you screen's copy. `decision` is the engine's internal
        // verdict; don't render it raw.
        outcome: {
          workerApproved: result.workerStatus === 'approved',
          underReview: !result.autoFinalized,
        },
      },
      result.workerStatus === 'approved'
        ? 'Thank you — your feedback helped a new professional get onboarded'
        : 'Thank you — your feedback has been recorded'
    );
  } catch (err) {
    next(err);
  }
}

module.exports = {
  loadOwnedTrial,
  getOffer,
  createTrial,
  listTrials,
  activeTrial,
  getTrial,
  cancelTrial,
  retryTrial,
  initiatePayment,
  confirmPayment,
  getFeedbackForm,
  submitFeedback,
};
