const AssessmentSlot = require('../models/AssessmentSlot');
const WorkerAssessment = require('../models/WorkerAssessment');
const ShopPartner = require('../models/ShopPartner');
const { ok, fail } = require('../utils/response');
const { transitionWorker } = require('../services/workerStatusService');
const booking = require('../services/assessmentBookingService');
const notify = require('../services/assessmentNotifyService');
const tokenService = require('../services/assessmentTokenService');
const { distanceKm, distanceMeters, isValidCoord } = require('../utils/geo');
const { localDateKey, relativeDayLabel } = require('../utils/slotTime');
const {
  slotView,
  assessmentWorkerView,
  certificateView,
  checkInWindow,
  shopView,
} = require('../utils/assessmentPayload');
const {
  SLOT_SEARCH_MAX_RADIUS_KM,
  SLOT_SEARCH_DEFAULT_DAYS,
  CHECKIN_RADIUS_METERS,
  CHECKIN_OPENS_MINUTES_BEFORE,
  CANCEL_CUTOFF_HOURS,
  CANCELLATIONS_BEFORE_FLAG,
  FEEDBACK_SLA_MINUTES,
} = require('../config/assessmentConfig');

// Static copy for Screen 1 (the assessment introduction). Kept server-side so it
// can change without shipping a new app build — same reasoning as the video
// task's TASKS/TIPS block.
const INTRO = {
  heading: 'One last step before you go live',
  explanation:
    'We will send you to a local electrical shop near you for a 45-minute hands-on skill check. The shop owner will give you a few basic electrical tasks to complete. This is not an exam — just a chance to show what you can do.',
  whatToExpect: [
    'You will fix or assemble basic electrical components.',
    'The shop owner will watch you work and submit a review.',
    'You will hear back from us within 24 hours of completing the session.',
  ],
  whatToBring: [
    'Your own tools if you have them.',
    'A valid ID.',
    'Comfortable clothes you do not mind getting dirty.',
  ],
  ctaLabel: 'Find Assessment Slots Near Me',
};

// The guide's endpoints carry workerId in the path/body. Trusting a client-
// supplied id would let any authenticated worker act on another's assessment, so
// it is accepted (for shape compatibility) but must match the JWT's worker.
function workerIdMismatch(req, supplied) {
  if (supplied === undefined || supplied === null || supplied === '') return false;
  return String(supplied) !== String(req.worker._id);
}

async function loadOwnedAssessment(req, res, assessmentId) {
  const assessment = await WorkerAssessment.findById(assessmentId);
  if (!assessment) {
    fail(res, 'Assessment not found', 404);
    return null;
  }
  if (String(assessment.worker) !== String(req.worker._id)) {
    fail(res, 'This assessment does not belong to you', 403);
    return null;
  }
  return assessment;
}

// The worker's current (in-flight) assessment, if any.
async function findLiveAssessment(workerId) {
  return WorkerAssessment.findOne({
    worker: workerId,
    status: { $in: booking.LIVE_STATUSES },
  }).sort({ createdAt: -1 });
}

// GET /api/worker/assessment/intro
async function getIntro(req, res, next) {
  try {
    const eligibility = await booking.checkEligibility(req.worker);
    return ok(
      res,
      {
        intro: INTRO,
        eligible: eligibility.ok,
        reason: eligibility.ok ? null : eligibility.message,
        retryAt: eligibility.retryAt || null,
      },
      'Assessment introduction'
    );
  } catch (err) {
    next(err);
  }
}

// GET /api/worker/assessment/available-slots
//   ?workerId=&city=&latitude=&longitude=&dateFrom=&dateTo=
async function availableSlots(req, res, next) {
  try {
    if (workerIdMismatch(req, req.query.workerId)) {
      return fail(res, 'workerId does not match the authenticated worker', 403);
    }

    // Gate on eligibility first — this is the "all prior steps completed" check.
    // A worker who already has a live booking gets it back so the app can jump
    // straight to the confirmation screen instead of showing an empty picker.
    const eligibility = await booking.checkEligibility(req.worker);
    if (!eligibility.ok) {
      const live = await findLiveAssessment(req.worker._id);
      const partner = live ? await ShopPartner.findById(live.shopPartner) : null;
      return fail(res, eligibility.message, eligibility.code, {
        reason: eligibility.reason,
        retryAt: eligibility.retryAt,
        currentAssessment: live ? assessmentWorkerView(live, partner, req.worker) : null,
      });
    }

    // Where is the worker? Explicit coords win; otherwise fall back to the
    // dispatch heartbeat location. Without either we can still list slots, just
    // without distances.
    const lat = req.query.latitude !== undefined ? Number(req.query.latitude) : undefined;
    const lng = req.query.longitude !== undefined ? Number(req.query.longitude) : undefined;
    let origin = null;
    if (isValidCoord(lat, lng)) {
      origin = { lat, lng };
    } else {
      const c = req.worker.currentLocation && req.worker.currentLocation.coordinates;
      if (c && c.length === 2) origin = { lat: c[1], lng: c[0] };
    }

    // City filter: explicit param, else the worker's onboarding city. Pass
    // city=any to search every city (useful for ops/testing).
    const cityParam = req.query.city;
    const city =
      cityParam === 'any'
        ? null
        : cityParam || (req.worker.location && req.worker.location.city) || null;

    // Find active shops, nearest first when we know where the worker is.
    const findPartners = async (withCity) => {
      const query = { status: 'active' };
      if (withCity) query.city = new RegExp(`^${String(withCity).trim()}$`, 'i');
      if (!origin) return ShopPartner.find(query).limit(100).lean();
      return ShopPartner.aggregate([
        {
          $geoNear: {
            near: { type: 'Point', coordinates: [origin.lng, origin.lat] },
            distanceField: 'distanceMeters',
            maxDistance: SLOT_SEARCH_MAX_RADIUS_KM * 1000,
            spherical: true,
            query,
          },
        },
        { $limit: 100 },
      ]);
    };

    // The city name is a SOFT preference, not a hard gate: distance is the real
    // constraint, and city strings are the brittle part ("Bangalore" vs
    // "Bengaluru", or a worker in Secunderabad next to a Hyderabad shop 8 km
    // away). So prefer shops in the worker's own city, and if that finds nothing,
    // fall back to whatever is genuinely nearby.
    //
    // The fallback only runs when we have the worker's coordinates — without them
    // there is no radius bound, and dropping the city filter would offer a worker
    // in Delhi a shop in Hyderabad.
    let partners = await findPartners(city);
    let matchedBy = city ? 'city_and_distance' : 'distance';
    if (city && !partners.length && origin) {
      partners = await findPartners(null);
      if (partners.length) matchedBy = 'distance_only';
    }

    if (!partners.length) {
      return ok(
        res,
        {
          slots: [],
          slotsByDate: [],
          totalSlots: 0,
          searchRadiusKm: SLOT_SEARCH_MAX_RADIUS_KM,
          city,
          matchedBy: 'none',
        },
        origin
          ? `No partner shops found within ${SLOT_SEARCH_MAX_RADIUS_KM} km of you yet`
          : 'No partner shops found near you yet'
      );
    }

    const partnerById = new Map(partners.map((p) => [String(p._id), p]));

    // Date window: defaults to the next SLOT_SEARCH_DEFAULT_DAYS days. The worker
    // app sends fromDate/toDate; dateFrom/dateTo are accepted as aliases.
    const now = new Date();
    const fromRaw = req.query.fromDate || req.query.dateFrom;
    const toRaw = req.query.toDate || req.query.dateTo;
    const from = fromRaw ? new Date(`${fromRaw}T00:00:00.000Z`) : now;
    const to = toRaw
      ? new Date(`${toRaw}T23:59:59.999Z`)
      : new Date(now.getTime() + SLOT_SEARCH_DEFAULT_DAYS * 24 * 60 * 60 * 1000);
    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      return fail(res, 'fromDate and toDate must be YYYY-MM-DD dates', 422);
    }

    const slots = await AssessmentSlot.find({
      shopPartner: { $in: partners.map((p) => p._id) },
      isAvailable: true,
      capacityRemaining: { $gte: 1 },
      cancelledAt: null,
      // Never offer a slot that has already started.
      startsAt: { $gt: new Date(Math.max(now.getTime(), from.getTime())), $lte: to },
    })
      .sort({ startsAt: 1 })
      .limit(500)
      .lean();

    // Shape into the grouped-by-date, sorted-by-distance structure the picker
    // renders. A flat `slots` array is returned alongside it (already in the same
    // distance-then-time order) because the worker app accepts either and the flat
    // shape is the one its contract pins down exactly.
    const flat = [];
    const groups = new Map();
    for (const slot of slots) {
      const partner = partnerById.get(String(slot.shopPartner));
      if (!partner) continue;
      const km = origin
        ? partner.distanceMeters !== undefined
          ? Math.round((partner.distanceMeters / 1000) * 100) / 100
          : distanceKm(origin.lat, origin.lng, partner.location.coordinates[1], partner.location.coordinates[0])
        : null;

      const view = slotView(slot, partner, km);
      const key = localDateKey(slot.startsAt);
      if (!groups.has(key)) {
        groups.set(key, { date: key, label: relativeDayLabel(slot.startsAt), slots: [] });
      }
      groups.get(key).slots.push(view);
      flat.push(view);
    }

    // Nearest shop first within each day; ties broken by time.
    const byDistanceThenTime = (a, b) => {
      const da = a.distanceKm ?? Number.MAX_SAFE_INTEGER;
      const db = b.distanceKm ?? Number.MAX_SAFE_INTEGER;
      if (da !== db) return da - db;
      return new Date(a.startsAt) - new Date(b.startsAt);
    };

    const slotsByDate = Array.from(groups.values())
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((group) => ({ ...group, slots: group.slots.sort(byDistanceThenTime) }));

    // Flat list: day order first (so client-side grouping preserves it), then
    // distance within the day — the app relies on server order inside a day.
    flat.sort((a, b) => {
      if (a.slotDate !== b.slotDate) return a.slotDate.localeCompare(b.slotDate);
      return byDistanceThenTime(a, b);
    });

    return ok(
      res,
      {
        slots: flat,
        slotsByDate,
        totalSlots: slots.length,
        searchRadiusKm: SLOT_SEARCH_MAX_RADIUS_KM,
        city,
        // 'city_and_distance' | 'distance_only' (city had no shops, nearest used)
        // | 'distance' (no city on file) — informational, for ops/debugging.
        matchedBy,
        locationUsed: origin,
      },
      slots.length ? 'Available assessment slots' : 'No slots available in this window'
    );
  } catch (err) {
    next(err);
  }
}

// POST /api/worker/assessment/book-slot   { workerId?, slotId }
async function bookSlot(req, res, next) {
  try {
    const { workerId, slotId } = req.body || {};
    if (workerIdMismatch(req, workerId)) {
      return fail(res, 'workerId does not match the authenticated worker', 403);
    }
    if (!slotId) return fail(res, 'slotId is required', 422);

    const eligibility = await booking.checkEligibility(req.worker);
    if (!eligibility.ok) {
      return fail(res, eligibility.message, eligibility.code, {
        reason: eligibility.reason,
        retryAt: eligibility.retryAt,
        assessmentId: eligibility.assessmentId,
      });
    }

    const result = await booking.bookSlot(req.worker, slotId);
    if (!result.ok) return fail(res, result.message, result.code, { reason: result.reason });

    const { assessment, partner } = result;

    await transitionWorker(req.worker, 'assessment_booked', {
      reason: `Assessment booked at ${partner.shopName}`,
      assessment: assessment._id,
    });
    req.worker.electricalAssessment.stage = 'booked';
    req.worker.electricalAssessment.attempt = assessment.attempt;
    await req.worker.save();

    // Mint the shop owner's feedback link now — the booking SMS carries it, and
    // the same link stays valid until 24h after the slot ends.
    const feedbackLink = tokenService.buildLink(
      tokenService.sign(assessment._id, assessment.scheduledEndAt)
    );

    notify.pushAssessmentUpdate(req.worker._id, assessment);
    await notify
      .bookingConfirmed({ worker: req.worker, partner, assessment, feedbackLink })
      .catch((e) => console.error('[assessment] booking notifications failed:', e.message));

    return ok(
      res,
      { assessment: assessmentWorkerView(assessment, partner, req.worker) },
      'Your assessment is booked',
      201
    );
  } catch (err) {
    next(err);
  }
}

// POST /api/worker/assessment/cancel-booking
//   { workerId?, assessmentId, cancellationReason }
async function cancelBooking(req, res, next) {
  try {
    const { workerId, assessmentId, cancellationReason } = req.body || {};
    if (workerIdMismatch(req, workerId)) {
      return fail(res, 'workerId does not match the authenticated worker', 403);
    }
    if (!assessmentId) return fail(res, 'assessmentId is required', 422);
    if (!cancellationReason || !String(cancellationReason).trim()) {
      return fail(res, 'cancellationReason is required', 422);
    }

    const assessment = await loadOwnedAssessment(req, res, assessmentId);
    if (!assessment) return;

    if (!['booked', 'confirmed'].includes(assessment.status)) {
      return fail(res, `This assessment can no longer be cancelled (status: ${assessment.status})`, 409);
    }

    const hoursAway = (assessment.scheduledAt.getTime() - Date.now()) / (60 * 60 * 1000);
    if (hoursAway < CANCEL_CUTOFF_HOURS) {
      return fail(
        res,
        `Bookings can only be cancelled at least ${CANCEL_CUTOFF_HOURS} hours in advance. Please attend, or contact support.`,
        409
      );
    }

    assessment.status = 'cancelled';
    assessment.cancelledAt = new Date();
    assessment.cancelledBy = 'worker';
    assessment.cancellationReason = String(cancellationReason).trim();
    await assessment.save();

    // Free the seat for other workers.
    await booking.releaseSlot(assessment.slot).catch((e) =>
      console.error(`[assessment] failed to release slot ${assessment.slot}:`, e.message)
    );

    // Repeated cancellations are an ops signal, not an automatic block.
    const block = req.worker.electricalAssessment;
    block.cancellationCount = (block.cancellationCount || 0) + 1;
    block.stage = 'awaiting_booking';
    if (block.cancellationCount >= CANCELLATIONS_BEFORE_FLAG) block.flaggedForReview = true;
    await req.worker.save();

    await transitionWorker(req.worker, 'pending_assessment', {
      reason: `Worker cancelled assessment — ${assessment.cancellationReason}`,
      assessment: assessment._id,
    });

    notify.pushAssessmentUpdate(req.worker._id, assessment);
    const partner = await ShopPartner.findById(assessment.shopPartner);
    if (partner) {
      await notify
        .bookingCancelled({
          worker: req.worker,
          partner,
          assessment,
          reason: assessment.cancellationReason,
        })
        .catch((e) => console.error('[assessment] cancel notifications failed:', e.message));
    }
    if (block.flaggedForReview) {
      await notify
        .opsAlert(
          `Worker ${req.worker.fullName || req.worker.phone} has now cancelled ${block.cancellationCount} assessments — profile flagged for review.`
        )
        .catch(() => {});
    }

    return ok(
      res,
      { assessment: assessmentWorkerView(assessment, partner, req.worker), flaggedForReview: !!block.flaggedForReview },
      'Your booking has been cancelled'
    );
  } catch (err) {
    next(err);
  }
}

// POST /api/worker/assessment/check-in
//   { workerId?, assessmentId, latitude, longitude }
async function checkIn(req, res, next) {
  try {
    const { workerId, assessmentId, latitude, longitude } = req.body || {};
    if (workerIdMismatch(req, workerId)) {
      return fail(res, 'workerId does not match the authenticated worker', 403);
    }
    if (!assessmentId) return fail(res, 'assessmentId is required', 422);

    const lat = Number(latitude);
    const lng = Number(longitude);
    if (!isValidCoord(lat, lng)) {
      return fail(res, 'Valid numeric latitude and longitude are required to check in', 422);
    }

    const assessment = await loadOwnedAssessment(req, res, assessmentId);
    if (!assessment) return;

    if (assessment.status === 'worker_arrived') {
      return fail(res, 'You have already checked in for this assessment', 409);
    }
    if (!['booked', 'confirmed'].includes(assessment.status)) {
      return fail(res, `You cannot check in for this assessment (status: ${assessment.status})`, 409);
    }

    // Time gate: the button is only live around the slot start.
    // 400 (not 409) because the worker app renders `message` verbatim on a 400
    // from this endpoint; `reason` lets it branch precisely if it wants to.
    const window = checkInWindow(assessment);
    if (!window.isOpen) {
      const early = Date.now() < window.opensAt.getTime();
      return fail(
        res,
        early
          ? `Check-in has not opened yet. You can check in from ${CHECKIN_OPENS_MINUTES_BEFORE} minutes before your slot.`
          : 'The check-in window for this assessment has closed. Please contact support.',
        400,
        { reason: early ? 'checkin_not_open_yet' : 'checkin_window_closed', checkIn: window }
      );
    }

    const partner = await ShopPartner.findById(assessment.shopPartner);
    if (!partner) return fail(res, 'Shop partner not found', 404);

    // Geofence: the worker must actually be at the shop.
    const coords = partner.location.coordinates;
    const metres = Math.round(distanceMeters(lat, lng, coords[1], coords[0]));
    if (metres > CHECKIN_RADIUS_METERS) {
      // 400 is the contract with the worker app for "outside the geofence" — it
      // shows this `message` verbatim. Do not reuse 400 for generic validation here.
      return fail(
        res,
        `You appear to be more than ${CHECKIN_RADIUS_METERS} metres from the shop. Please make sure you are at the correct location before checking in.`,
        400,
        {
          reason: 'outside_geofence',
          distanceMeters: metres,
          allowedMeters: CHECKIN_RADIUS_METERS,
          shop: shopView(partner),
        }
      );
    }

    const now = new Date();
    assessment.status = 'worker_arrived';
    assessment.workerArrivedAt = now;
    assessment.checkInLocation = { type: 'Point', coordinates: [lng, lat] };
    assessment.checkInDistanceMeters = metres;
    assessment.checkedInBy = 'worker';
    // Open the shop owner's feedback SLA window from the moment work starts.
    assessment.feedback.slaDeadlineAt = new Date(now.getTime() + FEEDBACK_SLA_MINUTES * 60 * 1000);
    await assessment.save();

    await transitionWorker(req.worker, 'assessment_checked_in', {
      reason: `Worker checked in at ${partner.shopName} (${metres} m from shop)`,
      assessment: assessment._id,
    });
    req.worker.electricalAssessment.stage = 'checked_in';
    await req.worker.save();

    notify.pushAssessmentUpdate(req.worker._id, assessment);
    await notify
      .workerCheckedIn({ worker: req.worker, partner })
      .catch((e) => console.error('[assessment] check-in notification failed:', e.message));

    return ok(
      res,
      {
        assessment: assessmentWorkerView(assessment, partner, req.worker),
        distanceMeters: metres,
        // So the worker can call the shop if they cannot find the owner.
        ownerPhone: partner.ownerPhone,
      },
      'You are checked in. The shop owner has been notified. Good luck with your assessment.'
    );
  } catch (err) {
    next(err);
  }
}

// GET /api/worker/assessment/status/:workerId?  — also served at /status
async function getStatus(req, res, next) {
  try {
    if (workerIdMismatch(req, req.params.workerId)) {
      return fail(res, 'workerId does not match the authenticated worker', 403);
    }

    // Latest assessment overall (not just live), so a rejected/no-show worker
    // still sees the outcome screen rather than an empty state.
    const assessment = await WorkerAssessment.findOne({ worker: req.worker._id }).sort({ createdAt: -1 });
    const partner = assessment ? await ShopPartner.findById(assessment.shopPartner) : null;
    const eligibility = await booking.checkEligibility(req.worker);
    const block = req.worker.electricalAssessment || {};

    return ok(
      res,
      {
        // `status` is the WORKER-level status — this is what the app's routing
        // table keys off to pick the assessment stack and the screen inside it.
        // `workerStatus` is the same value under the older name.
        status: req.worker.status,
        workerStatus: req.worker.status,
        stage: block.stage || 'not_started',
        assessment: assessmentWorkerView(assessment, partner, req.worker),
        certificate: certificateView(req.worker),
        canBook: eligibility.ok,
        blockedReason: eligibility.ok ? null : eligibility.message,
        counters: {
          attempt: block.attempt || 1,
          noShowCount: block.noShowCount || 0,
          cancellationCount: block.cancellationCount || 0,
        },
        bookingSuspendedUntil: block.bookingSuspendedUntil || null,
        reapplyAllowedAt: block.reapplyAllowedAt || null,
      },
      'Assessment status'
    );
  } catch (err) {
    next(err);
  }
}

// POST /api/worker/assessment/acknowledge-decision   { assessmentId?, workerId? }
// Called when the worker taps "Continue" on their certificate. Moves them from
// `assessment_approved` (certificate screen) to `approved` (main tabs + the
// dispatch gate), so the handover is instant rather than waiting on a sweep.
//
// Idempotent: acknowledging twice, or before a decision exists, is not an error —
// the app treats this call as best-effort and falls back to re-reading status.
async function acknowledgeDecision(req, res, next) {
  try {
    const { workerId, assessmentId } = req.body || {};
    if (workerIdMismatch(req, workerId)) {
      return fail(res, 'workerId does not match the authenticated worker', 403);
    }

    // Already handed over (or never needed to be) — report success, change nothing.
    if (req.worker.status !== 'assessment_approved') {
      return ok(
        res,
        { status: req.worker.status, acknowledged: false },
        'No pending assessment decision to acknowledge'
      );
    }

    if (assessmentId) {
      const owned = await loadOwnedAssessment(req, res, assessmentId);
      if (!owned) return;
    }

    await transitionWorker(req.worker, 'approved', {
      reason: 'Worker acknowledged their assessment approval',
      assessment: assessmentId || undefined,
    });

    return ok(res, { status: req.worker.status, acknowledged: true }, 'Welcome to Kaaryo');
  } catch (err) {
    next(err);
  }
}

// GET /api/worker/assessment/certificate
async function getCertificate(req, res, next) {
  try {
    const certificate = certificateView(req.worker);
    if (!certificate) {
      return fail(res, 'No certificate has been issued for this worker yet', 404);
    }
    return ok(res, { certificate }, 'Kaaryo Verified Electrician certificate');
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getIntro,
  availableSlots,
  bookSlot,
  cancelBooking,
  checkIn,
  getStatus,
  acknowledgeDecision,
  getCertificate,
  INTRO,
};
