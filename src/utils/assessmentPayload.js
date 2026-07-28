// Serializers for the assessment filter, mirroring utils/trialPayload.js so the
// worker app, the partner form and the admin panel all see stable shapes.

const {
  formatTime,
  formatDate,
  formatDateTime,
  localDateKey,
  relativeDayLabel,
} = require('./slotTime');
const {
  CHECKIN_RADIUS_METERS,
  CHECKIN_OPENS_MINUTES_BEFORE,
  CHECKIN_CLOSES_MINUTES_AFTER,
  CANCEL_CUTOFF_HOURS,
} = require('../config/assessmentConfig');

// Shop details the worker is allowed to see. The owner's phone is included from
// booking onwards (they may need to call about directions), matching the guide's
// confirmation screen which shows a tap-to-call button.
//
// Both `fullAddress`/`latitude`/`longitude` (the worker app's field names) and
// `shopAddress`/`lat`/`lng` are emitted — the two names for each value cost
// nothing and mean neither client has to adapt.
function shopView(partner, { distanceKm = null } = {}) {
  if (!partner) return null;
  const coords = (partner.location && partner.location.coordinates) || [];
  const lat = coords[1] ?? null;
  const lng = coords[0] ?? null;
  return {
    id: partner._id,
    shopName: partner.shopName,
    ownerName: partner.ownerName,
    ownerPhone: partner.ownerPhone,
    city: partner.city,
    locality: partner.locality,
    fullAddress: partner.fullAddress,
    shopAddress: partner.fullAddress,
    googleMapsLink:
      partner.googleMapsLink ||
      (coords.length === 2 ? `https://www.google.com/maps/search/?api=1&query=${lat},${lng}` : null),
    latitude: lat,
    longitude: lng,
    lat,
    lng,
    distanceKm,
  };
}

// One row in the worker's slot picker.
// slotDate/slotStartTime/slotEndTime are deliberately plain date and
// time-of-day strings, never ISO timestamps: the app renders them verbatim so a
// 10 AM slot can't drift onto another day through timezone conversion. The
// absolute instants are carried separately as startsAt/endsAt.
function slotView(slot, partner, distanceKm) {
  const shop = shopView(partner);
  return {
    slotId: slot._id,
    shopName: partner.shopName,
    shopAddress: partner.fullAddress,
    fullAddress: partner.fullAddress,
    locality: partner.locality,
    googleMapsLink: shop.googleMapsLink,
    distanceKm,
    slotDate: localDateKey(slot.startsAt),
    slotStartTime: slot.slotStartTime,
    slotEndTime: slot.slotEndTime,
    startsAt: slot.startsAt,
    endsAt: slot.endsAt,
    displayTime: `${formatTime(slot.startsAt)} to ${formatTime(slot.endsAt)}`,
    ownerName: partner.ownerName,
    ownerPhone: partner.ownerPhone,
    latitude: shop.latitude,
    longitude: shop.longitude,
    seatsLeft: slot.capacityRemaining,
  };
}

// Is the check-in button live right now? The app also computes this locally to
// enable/disable the button, but the server is the authority.
function checkInWindow(assessment) {
  const start = new Date(assessment.scheduledAt).getTime();
  const opensAt = new Date(start - CHECKIN_OPENS_MINUTES_BEFORE * 60 * 1000);
  const closesAt = new Date(start + CHECKIN_CLOSES_MINUTES_AFTER * 60 * 1000);
  const now = Date.now();
  return {
    opensAt,
    closesAt,
    isOpen: now >= opensAt.getTime() && now <= closesAt.getTime(),
    radiusMeters: CHECKIN_RADIUS_METERS,
  };
}

// What the app should tell the worker to do next, per status. Kept server-side so
// the copy can change without an app release (same reasoning as videoTaskController's TASKS).
const NEXT_STEPS = {
  booked:
    'Arrive 5 minutes early. Bring your tools if you have them. Tap Check In when you reach the shop.',
  confirmed: 'The shop has confirmed your slot. Arrive 5 minutes early and tap Check In when you get there.',
  worker_arrived:
    'You are checked in. The shop owner will guide you through 3 to 4 tasks over about 45 minutes.',
  assessment_complete: 'Your session is complete. We are waiting for the shop owner to submit their review.',
  feedback_submitted:
    'The shop owner has submitted their review. Kaaryo is doing a final check — you will hear back within 24 hours.',
  approved: 'You are a Kaaryo Verified Electrician. Continue to the next step of your application.',
  rejected: 'Thank you for attending. You may reapply after the cooldown period shown above.',
  no_show: 'You missed this appointment. Please book a new slot.',
  cancelled: 'This booking was cancelled. Please book a new slot when you are ready.',
};

/**
 * Worker-safe improvement areas for the rejection screen.
 *
 * The worker must NEVER see the rubric, the numeric scores or the shop owner's
 * raw answers (implementation guide, Screen 6: "a general reason, not a detailed
 * breakdown"). So this maps weak answers onto general, non-numeric coaching
 * phrases and hands back at most two — the app truncates to two anyway.
 */
function improvementAreasFor(feedback = {}) {
  const areas = [];
  // Safety first: if they worked live, that is the only thing worth saying.
  if (feedback.safetyFailed) {
    areas.push('Electrical safety — always switch off the breaker or MCB before touching any wiring');
  }
  if (feedback.repairQualityScore !== null && feedback.repairQualityScore <= 3) {
    areas.push('Quality and finish of electrical repair work');
  }
  if (feedback.toolHandlingScore !== null && feedback.toolHandlingScore <= 3) {
    areas.push('Confidence and familiarity with electrical tools');
  }
  if (feedback.askedSensibleQuestions === false) {
    areas.push('Asking questions when you are unsure, instead of guessing');
  }
  return areas.slice(0, 2);
}

// The general reason shown on the decision screen. Deliberately non-specific.
function decisionMessageFor(assessment) {
  if (assessment.finalDecision === 'approved') {
    return 'You passed your hands-on skill assessment. Welcome to Kaaryo.';
  }
  if (assessment.finalDecision !== 'rejected') return null;
  if (assessment.feedback && assessment.feedback.safetyFailed) {
    return 'The shop owner reported that safe working practice was not followed during the session. For our customers\' safety we cannot move forward with your application at this time.';
  }
  return 'After reviewing the shop owner\'s feedback, your practical skill assessment did not meet the standard we need right now. This is not a judgement of you as a person — many electricians reapply and pass.';
}

// The certificate card on the approved screen.
function certificateFor(worker) {
  const block = (worker && worker.electricalAssessment) || {};
  if (!block.certificateIssuedAt) return null;
  return {
    id: block.certificateId,
    title: 'Kaaryo Verified Electrician',
    issuedAt: block.certificateIssuedAt,
  };
}

/**
 * The worker's view of their own assessment. `worker` is optional but should be
 * passed whenever available — the cross-attempt counters (no-shows, suspension,
 * reapply date) and the certificate live on the worker, not the assessment, and
 * the app expects them flattened onto this object.
 */
function assessmentWorkerView(assessment, partner, worker = null) {
  if (!assessment) return null;
  // The worker app treats `canCancel` as authoritative (it overrides the client's
  // own rule), so this is where the policy lives. With CANCEL_CUTOFF_HOURS at its
  // default of 0 the button stays live until the slot actually starts — cancelling
  // late is always better than a no-show.
  const msUntilSlot = new Date(assessment.scheduledAt).getTime() - Date.now();
  const canCancel =
    ['booked', 'confirmed'].includes(assessment.status) &&
    msUntilSlot > 0 &&
    msUntilSlot > CANCEL_CUTOFF_HOURS * 60 * 60 * 1000;
  const block = (worker && worker.electricalAssessment) || {};
  const feedback = assessment.feedback || {};

  return {
    id: assessment._id,
    status: assessment.status,
    attempt: assessment.attempt,
    scheduledAt: assessment.scheduledAt,
    scheduledEndAt: assessment.scheduledEndAt,
    // Display strings for the slot, so the app never has to re-derive a
    // wall-clock time from the ISO instant.
    slotStartTime: formatTime(assessment.scheduledAt),
    slotEndTime: formatTime(assessment.scheduledEndAt),
    display: {
      day: relativeDayLabel(assessment.scheduledAt),
      date: formatDate(assessment.scheduledAt),
      time: `${formatTime(assessment.scheduledAt)} to ${formatTime(assessment.scheduledEndAt)}`,
      dateTime: formatDateTime(assessment.scheduledAt),
    },
    shop: shopView(partner),
    checkIn: checkInWindow(assessment),
    canCancel,
    cancelCutoffHours: CANCEL_CUTOFF_HOURS,
    workerArrivedAt: assessment.workerArrivedAt,
    assessmentCompletedAt: assessment.assessmentCompletedAt,
    feedbackSubmittedAt: assessment.feedbackSubmittedAt,
    nextSteps: NEXT_STEPS[assessment.status] || null,

    // ── Decision. The worker sees the outcome and general guidance only: never
    // the score, the rubric or the shop owner's raw answers. ──
    finalDecision: assessment.finalDecision || null,
    finalDecisionAt: assessment.finalDecisionAt || null,
    decisionMessage: decisionMessageFor(assessment),
    improvementAreas:
      assessment.finalDecision === 'rejected' ? improvementAreasFor(feedback) : null,
    reapplyAfter: block.reapplyAllowedAt || null,
    certificate: assessment.finalDecision === 'approved' ? certificateFor(worker) : null,
    // Kept for backwards compatibility with the earlier nested shape.
    decision: assessment.finalDecision
      ? { outcome: assessment.finalDecision, decidedAt: assessment.finalDecisionAt }
      : null,

    // ── Cross-attempt counters that gate re-booking ──
    noShowCount: block.noShowCount || 0,
    bookingSuspendedUntil: block.bookingSuspendedUntil || null,
    cancellationReason: assessment.cancellationReason || null,
  };
}

// The "Kaaryo Verified Electrician" certificate payload the app renders and
// turns into a shareable image.
function certificateView(worker) {
  const block = worker.electricalAssessment || {};
  if (!block.certificateIssuedAt) return null;
  return {
    certificateId: block.certificateId,
    workerName: worker.fullName,
    title: 'Kaaryo Verified Electrician',
    issuedAt: block.certificateIssuedAt,
    issuedOn: formatDate(block.certificateIssuedAt),
    city: worker.location && worker.location.city,
  };
}

// Full view for the ADMIN panel — includes feedback, score and payout state.
function assessmentAdminView(assessment) {
  if (!assessment) return null;
  const partner = assessment.shopPartner;
  const partnerPopulated = partner && partner.shopName;

  return {
    id: assessment._id,
    status: assessment.status,
    attempt: assessment.attempt,
    worker: assessment.worker,
    shopPartner: partnerPopulated
      ? { id: partner._id, shopName: partner.shopName, ownerName: partner.ownerName, ownerPhone: partner.ownerPhone, city: partner.city }
      : partner,
    slot: assessment.slot,
    scheduledAt: assessment.scheduledAt,
    scheduledEndAt: assessment.scheduledEndAt,
    displayDateTime: formatDateTime(assessment.scheduledAt),
    workerArrivedAt: assessment.workerArrivedAt,
    checkInDistanceMeters: assessment.checkInDistanceMeters,
    assessmentCompletedAt: assessment.assessmentCompletedAt,
    feedbackSubmittedAt: assessment.feedbackSubmittedAt,
    feedback: assessment.feedback,
    payment: assessment.payment,
    finalDecision: assessment.finalDecision,
    finalDecisionBy: assessment.finalDecisionBy,
    finalDecisionAt: assessment.finalDecisionAt,
    finalDecisionNotes: assessment.finalDecisionNotes,
    cancellationReason: assessment.cancellationReason,
    cancelledAt: assessment.cancelledAt,
    cancelledBy: assessment.cancelledBy,
    cancelledLate: assessment.cancelledLate,
    cancelledHoursBefore: assessment.cancelledHoursBefore,
    noShowMarkedAt: assessment.noShowMarkedAt,
    noShowMarkedBy: assessment.noShowMarkedBy,
    createdAt: assessment.createdAt,
  };
}

// Partner row for the admin partner dashboard.
function partnerAdminView(partner) {
  const stats = partner.stats || {};
  const decided = (stats.totalWorkersApproved || 0) + (stats.totalWorkersRejected || 0);
  return {
    id: partner._id,
    shopName: partner.shopName,
    ownerName: partner.ownerName,
    ownerPhone: partner.ownerPhone,
    ownerEmail: partner.ownerEmail,
    city: partner.city,
    locality: partner.locality,
    fullAddress: partner.fullAddress,
    googleMapsLink: shopView(partner).googleMapsLink,
    lat: shopView(partner).lat,
    lng: shopView(partner).lng,
    status: partner.status,
    feedbackChannel: partner.feedbackChannel,
    payment: partner.payment,
    stats,
    // Share of decided assessments that were approved — the "are they rubber-
    // stamping everyone?" signal ops actually looks at.
    approvalRate: decided ? Math.round(((stats.totalWorkersApproved || 0) / decided) * 100) : null,
    qualityHistory: partner.qualityHistory || [],
    autoActionedAt: partner.autoActionedAt,
    autoActionReason: partner.autoActionReason,
    onboardedAt: partner.onboardedAt,
    createdAt: partner.createdAt,
  };
}

module.exports = {
  shopView,
  slotView,
  checkInWindow,
  assessmentWorkerView,
  certificateView,
  certificateFor,
  improvementAreasFor,
  decisionMessageFor,
  assessmentAdminView,
  partnerAdminView,
  NEXT_STEPS,
};
