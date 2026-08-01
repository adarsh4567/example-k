// Serializers for trial jobs, mirroring utils/jobPayload.js so the worker app
// sees consistent shapes. The host's phone is hidden pre-accept (same rule as a
// normal job's customer contact) and revealed once the worker accepts.

// Safe to require at module scope: trackingService pulls in only utils/geo and
// a config file, so it can't close a cycle back to here (unlike ../models/Worker
// below, which is required lazily for exactly that reason).
const { trackingView } = require('../services/trackingService');

// View shown to the WORKER. `revealContact` becomes true after acceptance.
function trialWorkerView(job) {
  const revealContact = ['accepted', 'in_progress', 'completed'].includes(job.status);
  const t = job.tracking || {};
  return {
    id: job._id,
    type: 'trial',
    status: job.status,

    // ── What the worker may do right now ──
    // Mirrors the normal job's assignedView so the worker app's primary button
    // switches on the same field names in both flows. A trial needs no
    // `workStage`: `accepted` IS travelling and `in_progress` IS on-site here.
    shouldSendLocation: job.status === 'accepted',
    canStart: job.status === 'accepted',
    canComplete: job.status === 'in_progress',
    arrivalStatus: t.arrivalStatus || 'en_route',
    distanceMeters: t.distanceMeters ?? null,
    etaMinutes: t.etaMinutes ?? null,
    category: job.category,
    subcategory: job.subcategory,
    jobDescription: job.jobDescription,
    scheduledTime: job.scheduledTime,
    address: job.address,
    location: job.location,
    host: {
      name: job.host && job.host.name,
      phone: revealContact ? job.host && job.host.phone : undefined,
    },
    pricing: job.pricing,
    offerExpiresAt: job.offerExpiresAt,
    acceptedAt: job.acceptedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
  };
}

/**
 * The trial's `stage`, in the same vocabulary a normal booking uses.
 *
 *   assigned    → 'searching'
 *   accepted    → whatever the geofence says: en_route | arriving_soon | arrived
 *   in_progress → 'working'
 *   completed   → 'work_done'   (payment + the feedback form are still outstanding)
 *   declined/expired → 'ended'
 *
 * 'completed' maps to 'work_done' rather than 'completed' on purpose: a trial's
 * status stays `completed` forever — there is no later value — while the
 * customer still owes payment and the feedback that onboards the worker. Calling
 * it 'completed' on the customer's screen would say "nothing left to do" at the
 * exact moment two things are left to do. `feedbackPending` and `payment.payable`
 * below say which.
 */
function trialStageOf(job) {
  switch (job.status) {
    case 'assigned':
      return 'searching';
    case 'accepted':
      return (job.tracking && job.tracking.arrivalStatus) || 'en_route';
    case 'in_progress':
      return 'working';
    case 'completed':
      return 'work_done';
    default:
      return 'ended'; // declined | expired — the candidate queue was spent
  }
}

/**
 * View shown to the CUSTOMER who booked a trial from the app.
 *
 * Field names mirror the normal request payload (utils/requestPayload) wherever
 * the meaning is the same — `status`, `payment`, `canCancel`, `secondsRemaining` —
 * so the customer app reuses its existing payment and tracking components instead
 * of growing a parallel set for trials.
 *
 * Two things it does that the worker's view doesn't:
 *   • ships derived affordances (`canCancel`, `canRetry`, `feedbackPending`,
 *     `payment.payable`) rather than making the client re-derive them from a
 *     status matrix that only the server actually knows;
 *   • surfaces the trial ECONOMICS the customer cares about — what they'd have
 *     paid, what they save, what they get back — while hiding `workerEarning`,
 *     which is platform-internal exactly as in a normal job.
 */
async function trialUserView(job) {
  const Worker = require('../models/Worker');
  const now = new Date();
  const p = job.pricing || {};
  const pay = job.payment || {};
  const searching = job.status === 'assigned';
  const assigned = ['accepted', 'in_progress', 'completed'].includes(job.status);
  const feedbackSubmitted = !!(job.feedback && job.feedback.submittedAt);

  const secondsUntil = (d) => (d ? Math.max(0, Math.ceil((new Date(d).getTime() - now.getTime()) / 1000)) : null);

  const view = {
    id: job._id,
    type: 'trial',
    status: job.status,
    // The composed value the tracking screen renders from, with exactly the same
    // vocabulary as a normal booking's (utils/requestPayload.stageOf) so one map
    // component serves both flows. The mapping differs because the underlying
    // status enums do: here `accepted` is the travelling state and `in_progress`
    // is the working one, whereas a normal request splits `in_progress` with
    // `workStage`. That difference is exactly what this field hides.
    stage: trialStageOf(job),

    category: job.category,
    subcategory: job.subcategory,
    jobDescription: job.jobDescription,
    scheduledTime: job.scheduledTime,
    address: job.address,
    location: job.location,

    // ── Trial economics (see pricingService.computeTrialPrice) ──
    pricing: {
      currency: p.currency,
      basePrice: p.basePrice,                 // 110 — show struck through
      userPrice: p.userPrice ?? p.totalPrice, // 100 — what they pay
      userSavings: p.userSavings ?? null,     // 10
      userDiscountPercent: p.userDiscountPercent ?? null,
      rewardPercent: p.userRewardPercent ?? p.userWalletCreditPercent ?? null, // 40
      rewardAmount: p.userReward ?? p.userWalletCredit ?? null,                // 40
    },

    // ── Search telemetry ──
    // `offerExpiresAt` is the current professional's turn to respond;
    // `searchExpiresAt` is the deadline for the whole search across candidates.
    // Render the customer's countdown from the latter.
    searchAttempt: job.searchAttempt || 1,
    candidateNumber: job.candidateIndex >= 0 ? job.candidateIndex + 1 : null,
    candidateCount: (job.candidates || []).length,
    offerExpiresAt: searching ? job.offerExpiresAt || null : null,
    searchExpiresAt: searching ? job.searchExpiresAt || null : null,
    secondsRemaining: searching ? secondsUntil(job.searchExpiresAt) : 0,

    // ── Server-decided affordances ──
    canCancel: ['assigned', 'accepted', 'in_progress'].includes(job.status),
    canRetry: ['declined', 'expired'].includes(job.status),
    feedbackPending: job.status === 'completed' && !feedbackSubmitted,
    feedbackSubmitted,

    payment: {
      status: pay.status || 'not_due',
      // The only check the app needs to decide whether to show "Pay".
      payable: job.status === 'completed' && ['not_due', 'due', 'failed'].includes(pay.status || 'not_due'),
      amount: pay.amount ?? p.userPrice ?? null,
      currency: pay.currency || p.currency || null,
      method: pay.method || null,
      orderId: pay.orderId || null,
      transactionId: pay.transactionId || null,
      attempts: pay.attempts || 0,
      failureReason: pay.failureReason || null,
      dueAt: pay.dueAt || null,
      paidAt: pay.paidAt || null,
    },

    reward: {
      amount: (job.reward && job.reward.amount) ?? p.userReward ?? null,
      percent: (job.reward && job.reward.percent) ?? p.userRewardPercent ?? null,
      credited: !!(job.reward && job.reward.creditedAt),
      creditedAt: (job.reward && job.reward.creditedAt) || null,
    },

    acceptedAt: job.acceptedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    createdAt: job.createdAt,
  };

  // The professional's contact is revealed on acceptance — the same privacy line
  // a normal job draws around the worker's number.
  if (assigned && job.worker) {
    const worker = await Worker.findById(job.worker).select('fullName phone rating jobsCompleted');
    if (worker) {
      const candidate = (job.candidates || []).find((c) => String(c.worker) === String(worker._id));
      view.worker = {
        id: worker._id,
        name: worker.fullName,
        phone: worker.phone,
        rating: worker.rating,
        jobsCompleted: worker.jobsCompleted,
        // Distance measured when the offer went out — historical, fixed. The
        // moving one is `liveDistanceKm`, from the live block below.
        distanceKm: candidate ? candidate.distanceKm : null,
        // Honest labelling: this professional is completing their onboarding, and
        // the discount is the reason the customer is meeting them.
        isTrainee: true,
      };

      // Live tracking, spliced in ONLY while `accepted` — this flow's travelling
      // state, and the only state in which a ping is ever accepted (see
      // trialWorkerController.updateTrialLocation). Gating on `assigned` (which
      // also covers `in_progress`/`completed`) would leave the trainee's last GPS
      // fix — taken right before they started the job — on the payload forever,
      // the same leak fixed on the normal-booking side of this file
      // (utils/requestPayload.customerView). Identical field names to that
      // builder — `location`, `heading`, `etaMinutes`, `arrivalStatus`,
      // `locationStale` — are what let the customer app render one map component
      // for a trial and a normal booking; only the gating condition differs,
      // because the two flows split travel-vs-work on different fields.
      if (job.status === 'accepted') {
        Object.assign(view.worker, trackingView(job.tracking, now));
      }
    }
  }

  if (['declined', 'expired'].includes(job.status)) {
    view.endedReason = job.declinedReason;
    view.endedAt = job.declinedAt;
  }

  return view;
}

// Compact form for list screens — no worker lookup.
function trialSummaryView(job) {
  const p = job.pricing || {};
  return {
    id: job._id,
    type: 'trial',
    status: job.status,
    // Cheap — trialStageOf() reads only fields already on the row. Shipped so a
    // list card and the detail screen can't disagree about where the trainee is.
    stage: trialStageOf(job),
    etaMinutes: (job.tracking && job.tracking.etaMinutes) ?? null,
    category: job.category,
    subcategory: job.subcategory,
    userPrice: p.userPrice ?? p.totalPrice ?? null,
    currency: p.currency,
    rewardAmount: p.userReward ?? p.userWalletCredit ?? null,
    rewardCredited: !!(job.reward && job.reward.creditedAt),
    paymentStatus: (job.payment && job.payment.status) || 'not_due',
    feedbackSubmitted: !!(job.feedback && job.feedback.submittedAt),
    canRetry: ['declined', 'expired'].includes(job.status),
    createdAt: job.createdAt,
    completedAt: job.completedAt || null,
  };
}

// Full view for the ADMIN panel — includes checkout + feedback.
function trialAdminView(job) {
  return {
    id: job._id,
    worker: job.worker,
    status: job.status,
    category: job.category,
    subcategory: job.subcategory,
    jobDescription: job.jobDescription,
    scheduledTime: job.scheduledTime,
    host: job.host,
    address: job.address,
    location: job.location,
    pricing: job.pricing,
    offerExpiresAt: job.offerExpiresAt,
    acceptedAt: job.acceptedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    declinedAt: job.declinedAt,
    declinedReason: job.declinedReason,
    checkout: job.checkout,
    feedback: job.feedback,
    createdAt: job.createdAt,
  };
}

module.exports = { trialWorkerView, trialUserView, trialSummaryView, trialAdminView, trialStageOf };
