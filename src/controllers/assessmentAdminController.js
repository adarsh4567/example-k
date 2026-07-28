const crypto = require('crypto');
const ShopPartner = require('../models/ShopPartner');
const AssessmentSlot = require('../models/AssessmentSlot');
const WorkerAssessment = require('../models/WorkerAssessment');
const Worker = require('../models/Worker');
const { ok, fail } = require('../utils/response');
const { isValidPhone } = require('../utils/validators');
const { isValidCoord } = require('../utils/geo');
const booking = require('../services/assessmentBookingService');
const notify = require('../services/assessmentNotifyService');
const partnerQuality = require('../services/partnerQualityService');
const assessmentJobs = require('../services/assessmentJobsService');
const tokenService = require('../services/assessmentTokenService');
const { transitionWorker } = require('../services/workerStatusService');
const { sendPayout } = require('../services/payoutService');
const { assessmentAdminView, partnerAdminView } = require('../utils/assessmentPayload');
const slotTime = require('../utils/slotTime');
const {
  PAYMENT_UPFRONT,
  PAYMENT_DEFERRED,
  SLOT_DURATION_MINUTES,
  REAPPLY_COOLDOWN_DAYS,
} = require('../config/assessmentConfig');

// ════════════════════════════════════════════════════════════════════════════
// API GROUP 1 — Shop partner management
// ════════════════════════════════════════════════════════════════════════════

// POST /api/admin/shop-partners
async function createPartner(req, res, next) {
  try {
    const b = req.body || {};
    const required = ['shopName', 'ownerName', 'ownerPhone', 'city', 'fullAddress'];
    for (const field of required) {
      if (!b[field] || !String(b[field]).trim()) return fail(res, `${field} is required`, 422);
    }
    if (!isValidPhone(b.ownerPhone)) {
      return fail(res, 'ownerPhone must be a valid 10-digit Indian mobile number', 422);
    }

    const lat = Number(b.latitude ?? b.lat);
    const lng = Number(b.longitude ?? b.lng);
    if (!isValidCoord(lat, lng)) {
      return fail(res, 'Valid numeric latitude and longitude are required', 422);
    }

    const existing = await ShopPartner.findOne({ ownerPhone: String(b.ownerPhone).trim() });
    if (existing) {
      return fail(res, 'A shop partner with this owner phone already exists', 409, {
        partnerId: existing._id,
      });
    }

    const upfront = Number(b.upfrontPayment ?? PAYMENT_UPFRONT);
    const deferred = Number(b.deferredPayment ?? PAYMENT_DEFERRED);

    const partner = await ShopPartner.create({
      shopName: String(b.shopName).trim(),
      ownerName: String(b.ownerName).trim(),
      ownerPhone: String(b.ownerPhone).trim(),
      ownerEmail: b.ownerEmail ? String(b.ownerEmail).trim() : null,
      city: String(b.city).trim(),
      locality: b.locality ? String(b.locality).trim() : '',
      fullAddress: String(b.fullAddress).trim(),
      location: { type: 'Point', coordinates: [lng, lat] },
      googleMapsLink: b.googleMapsLink || null,
      status: ['active', 'paused', 'terminated'].includes(b.status) ? b.status : 'active',
      feedbackChannel: ['sms', 'whatsapp', 'both'].includes(b.feedbackChannel)
        ? b.feedbackChannel
        : 'both',
      payment: {
        perAssessment: Number(b.paymentPerAssessment ?? upfront + deferred),
        upfront,
        deferred,
        method: b.paymentMethod || null,
        upiId: b.upiId || null,
      },
      onboardedAt: b.onboardedAt ? new Date(b.onboardedAt) : new Date(),
    });

    return ok(res, { partner: partnerAdminView(partner) }, 'Shop partner created', 201);
  } catch (err) {
    next(err);
  }
}

// GET /api/admin/shop-partners?city=&status=&minQualityScore=&page=&limit=
async function listPartners(req, res, next) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Number(req.query.limit) || 20);

    const query = {};
    if (req.query.city) query.city = new RegExp(`^${String(req.query.city).trim()}$`, 'i');
    if (req.query.status) query.status = req.query.status;
    if (req.query.minQualityScore !== undefined) {
      query['stats.partnerQualityScore'] = { $gte: Number(req.query.minQualityScore) };
    }
    if (req.query.maxQualityScore !== undefined) {
      query['stats.partnerQualityScore'] = {
        ...(query['stats.partnerQualityScore'] || {}),
        $lte: Number(req.query.maxQualityScore),
      };
    }

    const [total, partners] = await Promise.all([
      ShopPartner.countDocuments(query),
      ShopPartner.find(query)
        .sort({ 'stats.partnerQualityScore': 1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
    ]);

    return ok(
      res,
      { total, page, limit, partners: partners.map(partnerAdminView) },
      'Shop partners fetched'
    );
  } catch (err) {
    next(err);
  }
}

// GET /api/admin/shop-partners/:partnerId
// Full detail: the partner, their assessment history, and their payment history.
async function getPartner(req, res, next) {
  try {
    const partner = await ShopPartner.findById(req.params.partnerId);
    if (!partner) return fail(res, 'Shop partner not found', 404);

    const [assessments, slots] = await Promise.all([
      WorkerAssessment.find({ shopPartner: partner._id })
        .populate('worker', 'fullName phone status rating jobsCompleted')
        .sort({ scheduledAt: -1 })
        .limit(200),
      AssessmentSlot.find({ shopPartner: partner._id, startsAt: { $gt: new Date() } })
        .sort({ startsAt: 1 })
        .limit(200),
    ]);

    const payments = assessments.map((a) => ({
      assessmentId: a._id,
      worker: a.worker,
      scheduledAt: a.scheduledAt,
      status: a.status,
      ...(a.payment.toObject ? a.payment.toObject() : a.payment),
    }));

    return ok(
      res,
      {
        partner: partnerAdminView(partner),
        assessments: assessments.map(assessmentAdminView),
        upcomingSlots: slots,
        payments,
      },
      'Shop partner detail'
    );
  } catch (err) {
    next(err);
  }
}

// PATCH /api/admin/shop-partners/:partnerId   — edit partner details
async function updatePartner(req, res, next) {
  try {
    const partner = await ShopPartner.findById(req.params.partnerId);
    if (!partner) return fail(res, 'Shop partner not found', 404);

    const b = req.body || {};
    const textFields = [
      'shopName', 'ownerName', 'ownerEmail', 'city', 'locality',
      'fullAddress', 'googleMapsLink',
    ];
    for (const f of textFields) {
      if (b[f] !== undefined) partner[f] = b[f] === null ? null : String(b[f]).trim();
    }
    if (b.ownerPhone !== undefined) {
      if (!isValidPhone(b.ownerPhone)) return fail(res, 'ownerPhone must be a valid 10-digit mobile number', 422);
      partner.ownerPhone = String(b.ownerPhone).trim();
    }
    if (b.feedbackChannel !== undefined) {
      if (!['sms', 'whatsapp', 'both'].includes(b.feedbackChannel)) {
        return fail(res, 'feedbackChannel must be sms, whatsapp or both', 422);
      }
      partner.feedbackChannel = b.feedbackChannel;
    }
    if (b.latitude !== undefined || b.longitude !== undefined) {
      const lat = Number(b.latitude ?? partner.location.coordinates[1]);
      const lng = Number(b.longitude ?? partner.location.coordinates[0]);
      if (!isValidCoord(lat, lng)) return fail(res, 'Valid numeric latitude and longitude are required', 422);
      partner.location = { type: 'Point', coordinates: [lng, lat] };
    }
    for (const [key, field] of [
      ['upfrontPayment', 'upfront'],
      ['deferredPayment', 'deferred'],
      ['paymentPerAssessment', 'perAssessment'],
    ]) {
      if (b[key] !== undefined) partner.payment[field] = Number(b[key]);
    }
    if (b.paymentMethod !== undefined) partner.payment.method = b.paymentMethod;
    if (b.upiId !== undefined) partner.payment.upiId = b.upiId;

    await partner.save();
    return ok(res, { partner: partnerAdminView(partner) }, 'Shop partner updated');
  } catch (err) {
    next(err);
  }
}

// PATCH /api/admin/shop-partners/:partnerId/status   { status, reason? }
// Terminating (or pausing) a partner withdraws their future slots and tells any
// affected workers to rebook.
async function updatePartnerStatus(req, res, next) {
  try {
    const { status, reason } = req.body || {};
    if (!['active', 'paused', 'terminated'].includes(status)) {
      return fail(res, 'status must be active, paused or terminated', 422);
    }

    const partner = await ShopPartner.findById(req.params.partnerId);
    if (!partner) return fail(res, 'Shop partner not found', 404);

    const from = partner.status;
    partner.status = status;
    // A manual status change supersedes any automatic one.
    partner.autoActionedAt = null;
    partner.autoActionReason = null;
    await partner.save();

    let withdrawal = { slotsWithdrawn: 0, assessmentsCancelled: 0 };
    if (status !== 'active') {
      withdrawal = await booking.withdrawFutureSlots(
        partner._id,
        reason || `Partner ${status} by ${req.admin.email}`
      );
    }

    return ok(
      res,
      { partner: partnerAdminView(partner), from, ...withdrawal },
      `Shop partner ${status}`
    );
  } catch (err) {
    next(err);
  }
}

// POST /api/admin/shop-partners/:partnerId/slots
// body: { slots: [ { slotDate:'YYYY-MM-DD', slotStartTime:'HH:MM',
//                    slotEndTime?:'HH:MM', maxWorkersPerSlot?:1 } ] }
async function createSlots(req, res, next) {
  try {
    const partner = await ShopPartner.findById(req.params.partnerId);
    if (!partner) return fail(res, 'Shop partner not found', 404);

    const input = Array.isArray(req.body && req.body.slots) ? req.body.slots : null;
    if (!input || !input.length) return fail(res, 'slots must be a non-empty array', 422);
    if (input.length > 200) return fail(res, 'A maximum of 200 slots can be created per request', 422);

    const prepared = [];
    for (const [i, raw] of input.entries()) {
      const label = `slots[${i}]`;
      if (!slotTime.parseDate(raw.slotDate)) {
        return fail(res, `${label}.slotDate must be YYYY-MM-DD`, 422);
      }
      if (!slotTime.parseHHMM(raw.slotStartTime)) {
        return fail(res, `${label}.slotStartTime must be HH:MM (24-hour)`, 422);
      }
      // Default to a 1-hour window, which is the buffer the guide specifies.
      const endTime =
        raw.slotEndTime && slotTime.parseHHMM(raw.slotEndTime)
          ? raw.slotEndTime
          : slotTime.addMinutesToHHMM(raw.slotStartTime, SLOT_DURATION_MINUTES);

      const startsAt = slotTime.toInstant(raw.slotDate, raw.slotStartTime);
      const endsAt = slotTime.toInstant(raw.slotDate, endTime);
      if (!startsAt || !endsAt) return fail(res, `${label} has an unparseable date/time`, 422);
      if (endsAt <= startsAt) {
        return fail(res, `${label}.slotEndTime must be after slotStartTime`, 422);
      }

      const maxWorkers = Math.max(1, Number(raw.maxWorkersPerSlot) || 1);
      prepared.push({
        shopPartner: partner._id,
        slotDate: slotTime.dateOnly(raw.slotDate),
        slotStartTime: raw.slotStartTime,
        slotEndTime: endTime,
        startsAt,
        endsAt,
        maxWorkersPerSlot: maxWorkers,
        capacityRemaining: maxWorkers,
        isAvailable: true,
        createdBy: req.admin._id,
      });
    }

    // Skip slots that already exist for this shop at the same instant rather than
    // silently creating overlapping duplicates ops would have to clean up.
    const existing = await AssessmentSlot.find({
      shopPartner: partner._id,
      startsAt: { $in: prepared.map((p) => p.startsAt) },
      cancelledAt: null,
    }).select('startsAt');
    const taken = new Set(existing.map((e) => e.startsAt.getTime()));

    const toCreate = prepared.filter((p) => !taken.has(p.startsAt.getTime()));
    const created = toCreate.length ? await AssessmentSlot.insertMany(toCreate) : [];

    return ok(
      res,
      { created: created.length, skippedDuplicates: prepared.length - toCreate.length, slots: created },
      `${created.length} slot(s) created`,
      201
    );
  } catch (err) {
    next(err);
  }
}

// GET /api/admin/shop-partners/:partnerId/slots?includePast=false
async function listSlots(req, res, next) {
  try {
    const query = { shopPartner: req.params.partnerId };
    if (req.query.includePast !== 'true') query.startsAt = { $gt: new Date() };

    const slots = await AssessmentSlot.find(query).sort({ startsAt: 1 }).limit(500).lean();

    // Attach the booking (if any) so ops can see who holds each slot.
    const assessments = await WorkerAssessment.find({
      slot: { $in: slots.map((s) => s._id) },
    })
      .populate('worker', 'fullName phone')
      .select('slot worker status scheduledAt');
    const bySlot = new Map(assessments.map((a) => [String(a.slot), a]));

    return ok(
      res,
      {
        slots: slots.map((s) => ({
          ...s,
          booking: bySlot.get(String(s._id))
            ? {
                assessmentId: bySlot.get(String(s._id))._id,
                worker: bySlot.get(String(s._id)).worker,
                status: bySlot.get(String(s._id)).status,
              }
            : null,
        })),
        count: slots.length,
      },
      'Assessment slots'
    );
  } catch (err) {
    next(err);
  }
}

// DELETE /api/admin/shop-partners/:partnerId/slots/:slotId
async function deleteSlot(req, res, next) {
  try {
    const slot = await AssessmentSlot.findOne({
      _id: req.params.slotId,
      shopPartner: req.params.partnerId,
    });
    if (!slot) return fail(res, 'Slot not found for this partner', 404);
    if (slot.cancelledAt) return fail(res, 'This slot is already cancelled', 409);

    const reason = (req.body && req.body.reason) || `Slot withdrawn by ${req.admin.email}`;

    slot.cancelledAt = new Date();
    slot.cancelledReason = reason;
    slot.isAvailable = false;
    slot.capacityRemaining = 0;
    await slot.save();

    // If a worker held this slot, cancel their booking and ask them to rebook.
    const held = await WorkerAssessment.findOne({
      slot: slot._id,
      status: { $in: booking.LIVE_STATUSES },
    });
    let notified = false;
    if (held) {
      held.status = 'cancelled';
      held.cancelledAt = new Date();
      held.cancelledBy = 'admin';
      held.cancellationReason = reason;
      await held.save();

      const worker = await Worker.findById(held.worker);
      const partner = await ShopPartner.findById(slot.shopPartner);
      if (worker) {
        worker.electricalAssessment.stage = 'awaiting_booking';
        await worker.save();
        await transitionWorker(worker, 'pending_assessment', {
          actor: req.admin.email,
          reason: `Assessment slot withdrawn — ${reason}`,
          assessment: held._id,
        });
        if (partner) {
          await notify.slotWithdrawn({ worker, partner, assessment: held }).catch(() => {});
          notified = true;
        }
      }
    }

    return ok(res, { slotId: slot._id, cancelledBooking: !!held, workerNotified: notified }, 'Slot cancelled');
  } catch (err) {
    next(err);
  }
}

// POST /api/admin/shop-partners/:partnerId/recalculate-quality
// Manual trigger for the monthly job (useful for verifying the scoring rules).
async function recalculateQuality(req, res, next) {
  try {
    const result = await partnerQuality.scorePartner(req.params.partnerId);
    if (!result) return fail(res, 'Shop partner not found', 404);
    return ok(
      res,
      { partner: partnerAdminView(result.partner), snapshot: result.snapshot, autoAction: result.action },
      'Partner quality score recalculated'
    );
  } catch (err) {
    next(err);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// API GROUP 4 — Assessment review + decisions
// ════════════════════════════════════════════════════════════════════════════

// GET /api/admin/assessments/pending-review
// Everything awaiting an admin decision, oldest feedback first, with the full
// context the reviewer needs on one screen.
async function pendingReview(req, res, next) {
  try {
    const assessments = await WorkerAssessment.find({ status: 'feedback_submitted' })
      .populate('worker', 'fullName phone status location onboardingStep work expertise videoTask electricalAssessment rating jobsCompleted')
      .populate('shopPartner', 'shopName ownerName ownerPhone city locality stats status')
      .sort({ feedbackSubmittedAt: 1 })
      .limit(200);

    return ok(
      res,
      {
        assessments: assessments.map(assessmentAdminView),
        count: assessments.length,
      },
      'Assessments pending review'
    );
  } catch (err) {
    next(err);
  }
}

// GET /api/admin/assessments?status=&city=&partnerId=&workerId=&page=&limit=
// The "see everything" list backing the admin panel's assessment tab.
async function listAssessments(req, res, next) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Number(req.query.limit) || 20);

    const query = {};
    if (req.query.status) query.status = req.query.status;
    if (req.query.partnerId) query.shopPartner = req.query.partnerId;
    if (req.query.workerId) query.worker = req.query.workerId;
    if (req.query.safetyFailed === 'true') query['feedback.safetyFailed'] = true;

    const [total, assessments, counts] = await Promise.all([
      WorkerAssessment.countDocuments(query),
      WorkerAssessment.find(query)
        .populate('worker', 'fullName phone status')
        .populate('shopPartner', 'shopName city ownerName')
        .sort({ scheduledAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      // Status tallies for the dashboard header.
      WorkerAssessment.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    ]);

    return ok(
      res,
      {
        total,
        page,
        limit,
        assessments: assessments.map(assessmentAdminView),
        countsByStatus: counts.reduce((acc, c) => ({ ...acc, [c._id]: c.n }), {}),
      },
      'Assessments fetched'
    );
  } catch (err) {
    next(err);
  }
}

// GET /api/admin/assessments/:assessmentId
async function getAssessment(req, res, next) {
  try {
    const assessment = await WorkerAssessment.findById(req.params.assessmentId)
      .populate('worker')
      .populate('shopPartner');
    if (!assessment) return fail(res, 'Assessment not found', 404);

    const view = assessmentAdminView(assessment);
    // Convenience for testing and for ops re-sending the link by hand: while
    // feedback is still open, hand back a live partner form link.
    if (!assessment.feedback.submittedAt && !['cancelled', 'no_show'].includes(assessment.status)) {
      view.feedbackLink = tokenService.buildLink(
        tokenService.sign(assessment._id, assessment.scheduledEndAt)
      );
    }
    return ok(res, { assessment: view, worker: assessment.worker }, 'Assessment detail');
  } catch (err) {
    next(err);
  }
}

// POST /api/admin/assessments/:assessmentId/decide
// body: { decision: 'approved'|'rejected', adminNotes }
async function decideAssessment(req, res, next) {
  try {
    const b = req.body || {};
    // Accept both the guide's enum and the shorter verbs the trial endpoint uses.
    const raw = String(b.decision || '').toLowerCase();
    const decision = raw === 'approve' ? 'approved' : raw === 'reject' ? 'rejected' : raw;
    if (!['approved', 'rejected'].includes(decision)) {
      return fail(res, "decision must be 'approved' or 'rejected'", 422);
    }
    const notes = b.adminNotes || b.notes;
    if (decision === 'rejected' && (!notes || !String(notes).trim())) {
      return fail(res, 'adminNotes is required to reject', 422);
    }

    const assessment = await WorkerAssessment.findById(req.params.assessmentId);
    if (!assessment) return fail(res, 'Assessment not found', 404);
    if (assessment.status !== 'feedback_submitted') {
      return fail(
        res,
        `Only assessments with submitted feedback can be decided (status: ${assessment.status})`,
        409
      );
    }

    const [worker, partner] = await Promise.all([
      Worker.findById(assessment.worker),
      ShopPartner.findById(assessment.shopPartner),
    ]);
    if (!worker) return fail(res, 'Worker not found', 404);

    const now = new Date();
    assessment.finalDecision = decision;
    assessment.finalDecisionBy = req.admin._id;
    assessment.finalDecisionAt = now;
    assessment.finalDecisionNotes = notes ? String(notes).trim() : null;
    assessment.status = decision;
    await assessment.save();

    // Partner counters feed the quality score and the approval-rate column.
    if (partner) {
      if (decision === 'approved') {
        partner.stats.totalWorkersApproved = (partner.stats.totalWorkersApproved || 0) + 1;
      } else {
        partner.stats.totalWorkersRejected = (partner.stats.totalWorkersRejected || 0) + 1;
      }
      await partner.save();
    }

    const block = worker.electricalAssessment;

    if (decision === 'approved') {
      // Electricians skip the video task and the trial job, so a passed
      // assessment is the last gate. The worker lands on `assessment_approved`
      // (not `approved`) so the app shows the certificate screen; tapping
      // Continue there calls acknowledge-decision, which promotes them to
      // `approved` and opens the dispatch gate.
      block.stage = 'approved';
      block.certificateIssuedAt = now;
      block.certificateId = `KV-ELEC-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      await worker.save();

      await transitionWorker(worker, 'assessment_approved', {
        actor: req.admin.email,
        reason: `Shop assessment approved${notes ? ` — ${String(notes).trim()}` : ''}`,
        assessment: assessment._id,
      });
      notify.pushAssessmentUpdate(worker._id, assessment);
      await notify.decisionApproved({ worker }).catch(() => {});

      return ok(
        res,
        {
          assessment: assessmentAdminView(assessment),
          workerStatus: worker.status,
          certificateId: block.certificateId,
        },
        'Worker approved — Kaaryo Verified Electrician certificate issued'
      );
    }

    // Rejected: respectful message + a reapplication cooldown.
    const reapplyAllowedAt = new Date(now.getTime() + REAPPLY_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
    block.stage = 'rejected';
    block.reapplyAllowedAt = reapplyAllowedAt;
    await worker.save();

    // `assessment_rejected` rather than a plain `rejected`: it is what gives the
    // worker the tailored assessment-rejection screen (general reason + reapply
    // date) instead of the generic application-rejected one.
    await transitionWorker(worker, 'assessment_rejected', {
      actor: req.admin.email,
      reason: `Shop assessment rejected — ${String(notes).trim()}`,
      assessment: assessment._id,
    });
    notify.pushAssessmentUpdate(worker._id, assessment);
    await notify.decisionRejected({ worker, reapplyAllowedAt }).catch(() => {});

    return ok(
      res,
      { assessment: assessmentAdminView(assessment), workerStatus: worker.status, reapplyAllowedAt },
      'Worker rejected after assessment'
    );
  } catch (err) {
    next(err);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Payments
// ════════════════════════════════════════════════════════════════════════════

// GET /api/admin/assessments/payments/pending
async function pendingPayments(req, res, next) {
  try {
    const [upfront, deferred] = await Promise.all([
      // Feedback submitted but the upfront half never went out (e.g. a payout
      // provider error) — these are the ones ops must chase.
      WorkerAssessment.find({ 'feedback.submittedAt': { $ne: null }, 'payment.upfrontPaid': false })
        .populate('worker', 'fullName phone')
        .populate('shopPartner', 'shopName ownerName ownerPhone city payment')
        .sort({ feedbackSubmittedAt: 1 })
        .limit(200),
      WorkerAssessment.find({
        finalDecision: 'approved',
        'payment.upfrontPaid': true,
        'payment.deferredPaid': false,
      })
        .populate('worker', 'fullName phone jobsCompleted')
        .populate('shopPartner', 'shopName ownerName ownerPhone city payment')
        .sort({ finalDecisionAt: 1 })
        .limit(200),
    ]);

    const totals = {
      upfrontPendingAmount: upfront.reduce((s, a) => s + (a.payment.upfrontAmount || 0), 0),
      deferredPendingAmount: deferred.reduce((s, a) => s + (a.payment.deferredAmount || 0), 0),
    };

    return ok(
      res,
      {
        upfrontPending: upfront.map(assessmentAdminView),
        deferredPending: deferred.map(assessmentAdminView),
        counts: { upfront: upfront.length, deferred: deferred.length },
        totals,
      },
      'Pending assessment payments'
    );
  } catch (err) {
    next(err);
  }
}

// POST /api/admin/assessments/:assessmentId/payments/:kind/mark-paid
//   kind = 'upfront' | 'deferred'   body: { reference?, method?, retry? }
// Records a manual payout, or retries the mocked/real payout provider.
async function markPaymentPaid(req, res, next) {
  try {
    const kind = req.params.kind;
    if (!['upfront', 'deferred'].includes(kind)) {
      return fail(res, "kind must be 'upfront' or 'deferred'", 422);
    }

    const assessment = await WorkerAssessment.findById(req.params.assessmentId);
    if (!assessment) return fail(res, 'Assessment not found', 404);

    const paidField = `${kind}Paid`;
    if (assessment.payment[paidField]) {
      return fail(res, `The ${kind} payment is already marked paid`, 409);
    }

    const b = req.body || {};
    let reference = b.reference ? String(b.reference).trim() : null;

    // With no reference supplied, put the payout through the provider instead of
    // just flipping a flag — otherwise ops could mark money sent that never was.
    if (!reference) {
      const partner = await ShopPartner.findById(assessment.shopPartner);
      if (!partner) return fail(res, 'Shop partner not found', 404);
      const payout = await sendPayout(partner, {
        amount: assessment.payment[`${kind}Amount`],
        purpose: `assessment ${kind} (admin triggered)`,
        assessmentId: assessment._id,
      });
      reference = payout.reference;
    }

    assessment.payment[paidField] = true;
    assessment.payment[`${kind}PaidAt`] = new Date();
    assessment.payment[`${kind}Reference`] = reference;
    if (b.method) assessment.payment.method = b.method;
    if (kind === 'deferred' && !assessment.payment.deferredTriggerEvent) {
      assessment.payment.deferredTriggerEvent = `released manually by ${req.admin.email}`;
    }
    await assessment.save();

    return ok(res, { payment: assessment.payment }, `${kind} payment recorded`);
  } catch (err) {
    next(err);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Ops utility
// ════════════════════════════════════════════════════════════════════════════

// POST /api/admin/assessments/run-jobs   { task: 'all'|'noShows'|'feedbackSla'|'deferredPayments'|'partnerQuality' }
// Runs a background task on demand. The sweeper handles these automatically; this
// exists so ops (and end-to-end tests) don't have to wait for the next tick.
async function runJobs(req, res, next) {
  try {
    const task = (req.body && req.body.task) || 'all';
    const result = {};

    if (task === 'all' || task === 'noShows') {
      result.noShowsMarked = await assessmentJobs.detectNoShows();
    }
    if (task === 'all' || task === 'feedbackSla') {
      result.feedbackSla = await assessmentJobs.nudgeFeedback();
    }
    if (task === 'all' || task === 'deferredPayments') {
      result.deferredPaid = await assessmentJobs.processDeferredPayments();
    }
    if (task === 'all' || task === 'partnerQuality') {
      result.partnerQuality = await partnerQuality.runMonthly({ force: !!(req.body && req.body.force) });
    }

    if (!Object.keys(result).length) {
      return fail(
        res,
        "task must be one of: all, noShows, feedbackSla, deferredPayments, partnerQuality",
        422
      );
    }
    return ok(res, { task, result }, 'Assessment jobs run');
  } catch (err) {
    next(err);
  }
}

module.exports = {
  createPartner,
  listPartners,
  getPartner,
  updatePartner,
  updatePartnerStatus,
  createSlots,
  listSlots,
  deleteSlot,
  recalculateQuality,
  pendingReview,
  listAssessments,
  getAssessment,
  decideAssessment,
  pendingPayments,
  markPaymentPaid,
  runJobs,
};
