/**
 * Slot booking for the shop assessment filter.
 *
 * THE RACE CONDITION: two workers may tap "Book this slot" at the same moment.
 * The implementation guide prescribes a transaction with SELECT FOR UPDATE, which
 * is the relational answer. In MongoDB the equivalent — and stronger — primitive
 * is a single-document compare-and-swap: findOneAndUpdate() matching
 * `capacityRemaining >= 1` and decrementing it in the same operation. A single
 * document update is always atomic, so exactly one of the concurrent callers can
 * win. The loser gets `null` back and is told to pick another slot (409).
 *
 * No multi-document transaction is needed, which also means this works on any
 * deployment topology rather than requiring a replica set.
 *
 * If creating the WorkerAssessment then fails, releaseSlot() hands the capacity
 * back so a crashed booking does not silently burn a slot.
 */

const AssessmentSlot = require('../models/AssessmentSlot');
const WorkerAssessment = require('../models/WorkerAssessment');
const ShopPartner = require('../models/ShopPartner');
const { resolveWorkerCategory } = require('../utils/workerCategory');
const {
  ASSESSMENT_CATEGORY,
  PAYMENT_UPFRONT,
  PAYMENT_DEFERRED,
} = require('../config/assessmentConfig');

const LIVE_STATUSES = WorkerAssessment.LIVE_STATUSES;

/**
 * May this worker book an assessment right now?
 * @returns {{ok:true} | {ok:false, message:string, code:number}}
 */
async function checkEligibility(worker) {
  if (resolveWorkerCategory(worker) !== ASSESSMENT_CATEGORY) {
    return {
      ok: false,
      code: 403,
      reason: 'wrong_category',
      message: 'The shop assessment applies to electrical workers only',
    };
  }

  // Checked BEFORE the stage gate: a worker who already holds a booking is no
  // longer in `pending_assessment`, so the stage check would otherwise tell them
  // "you are not at the assessment stage yet" — which is both wrong and confusing
  // for someone who has just booked. The app surfaces this message directly.
  //
  // Deliberately NOT 409: on book-slot the worker app reads 409 as "that slot was
  // taken, pick another", and the remedy here is completely different (they
  // already hold a booking and should be shown it).
  const live = await WorkerAssessment.findOne({
    worker: worker._id,
    status: { $in: LIVE_STATUSES },
  });
  if (live) {
    return {
      ok: false,
      code: 403,
      reason: 'already_booked',
      message: 'You already have an assessment in progress',
      assessmentId: live._id,
    };
  }

  // The status gate IS the "all prior onboarding steps completed" check: a worker
  // only reaches pending_assessment when an admin clears application review.
  if (worker.status !== 'pending_assessment') {
    return {
      ok: false,
      code: 403,
      reason: 'wrong_stage',
      message: `You are not at the assessment stage yet (current status: ${worker.status})`,
    };
  }

  const block = worker.electricalAssessment || {};

  if (block.bookingSuspendedUntil && block.bookingSuspendedUntil.getTime() > Date.now()) {
    return {
      ok: false,
      code: 403,
      reason: 'booking_suspended',
      message: 'Assessment booking is temporarily paused on your profile because of missed appointments',
      retryAt: block.bookingSuspendedUntil,
    };
  }

  if (block.reapplyAllowedAt && block.reapplyAllowedAt.getTime() > Date.now()) {
    return {
      ok: false,
      code: 403,
      reason: 'reapply_cooldown',
      message: 'You are in a reapplication cooldown period',
      retryAt: block.reapplyAllowedAt,
    };
  }

  return { ok: true };
}

/**
 * Atomically claim one seat in a slot.
 * @returns the updated slot document, or null if it was already full/withdrawn.
 */
async function claimSlot(slotId) {
  return AssessmentSlot.findOneAndUpdate(
    {
      _id: slotId,
      capacityRemaining: { $gte: 1 },
      cancelledAt: null,
      startsAt: { $gt: new Date() }, // never book a slot that already started
    },
    [
      // Aggregation-pipeline update so isAvailable stays consistent with the
      // decremented counter inside the same atomic operation.
      {
        $set: {
          capacityRemaining: { $subtract: ['$capacityRemaining', 1] },
        },
      },
      {
        $set: {
          isAvailable: { $gt: ['$capacityRemaining', 0] },
          updatedAt: '$$NOW',
        },
      },
    ],
    { new: true }
  );
}

// Hand a seat back (booking failed downstream, worker cancelled, no-show).
async function releaseSlot(slotId) {
  return AssessmentSlot.findOneAndUpdate(
    { _id: slotId, cancelledAt: null },
    [
      {
        $set: {
          capacityRemaining: {
            // Never exceed the slot's own ceiling, however many releases arrive.
            $min: ['$maxWorkersPerSlot', { $add: ['$capacityRemaining', 1] }],
          },
        },
      },
      { $set: { isAvailable: { $gt: ['$capacityRemaining', 0] }, updatedAt: '$$NOW' } },
    ],
    { new: true }
  );
}

/**
 * Book a slot for a worker. Assumes eligibility was already checked.
 * @returns {{ok:true, assessment, slot, partner} | {ok:false, message, code}}
 */
// 409 from here means exactly one thing to the worker app: "this slot is gone,
// reload the list and pick another". Every case below that returns 409 has that
// same remedy; anything with a different remedy uses a different code.
async function bookSlot(worker, slotId) {
  const slot = await AssessmentSlot.findById(slotId);
  if (!slot) return { ok: false, code: 404, reason: 'slot_not_found', message: 'Assessment slot not found' };

  const partner = await ShopPartner.findById(slot.shopPartner);
  if (!partner) return { ok: false, code: 404, reason: 'partner_not_found', message: 'Shop partner not found' };
  if (partner.status !== 'active') {
    return {
      ok: false,
      code: 409,
      reason: 'shop_inactive',
      message: 'This shop is no longer accepting assessments. Please select a different slot.',
    };
  }
  // Checked before the CAS so an expired/withdrawn slot gets an accurate message
  // rather than the "someone else took it" one the CAS would otherwise produce.
  if (slot.cancelledAt) {
    return {
      ok: false,
      code: 409,
      reason: 'slot_withdrawn',
      message: 'This slot has been withdrawn. Please select a different slot.',
    };
  }
  if (slot.startsAt.getTime() <= Date.now()) {
    return {
      ok: false,
      code: 409,
      reason: 'slot_started',
      message: 'This slot has already started. Please select a later slot.',
    };
  }

  const claimed = await claimSlot(slotId);
  if (!claimed) {
    return {
      ok: false,
      code: 409,
      reason: 'slot_taken',
      message: 'This slot was just taken by another worker. Please select a different slot.',
    };
  }

  // Past this point the seat is ours — any failure must give it back.
  try {
    const previousAttempts = await WorkerAssessment.countDocuments({ worker: worker._id });
    const assessment = await WorkerAssessment.create({
      worker: worker._id,
      shopPartner: partner._id,
      slot: claimed._id,
      scheduledAt: claimed.startsAt,
      scheduledEndAt: claimed.endsAt,
      status: 'booked',
      attempt: previousAttempts + 1,
      payment: {
        upfrontAmount: partner.payment.upfront ?? PAYMENT_UPFRONT,
        deferredAmount: partner.payment.deferred ?? PAYMENT_DEFERRED,
        totalAmount:
          (partner.payment.upfront ?? PAYMENT_UPFRONT) + (partner.payment.deferred ?? PAYMENT_DEFERRED),
        method: partner.payment.method || null,
      },
    });
    return { ok: true, assessment, slot: claimed, partner };
  } catch (err) {
    await releaseSlot(slotId).catch((e) =>
      console.error(`[assessment] failed to release slot ${slotId} after booking error:`, e.message)
    );
    throw err;
  }
}

/**
 * Apply a no-show to an assessment: close the record, free the slot, bump the
 * worker's cumulative counter, suspend booking on the Nth strike, and put the
 * worker back in the booking queue.
 *
 * Shared by the shop owner's mark-no-show endpoint and the sweeper's automatic
 * detection so the policy exists in exactly one place. Deliberately pays nothing —
 * no assessment was conducted.
 *
 * @param {Document} assessment
 * @param {object} opts { markedBy: 'partner'|'system'|'admin', partner?, worker? }
 * @returns {{noShowCount:number, suspendedUntil:Date|null, worker, partner}}
 */
async function applyNoShow(assessment, { markedBy = 'system', partner = null, worker = null } = {}) {
  const Worker = require('../models/Worker');
  const notify = require('./assessmentNotifyService');
  const { transitionWorker } = require('./workerStatusService');
  const {
    NO_SHOWS_BEFORE_SUSPENSION,
    NO_SHOW_SUSPENSION_DAYS,
  } = require('../config/assessmentConfig');

  const now = new Date();
  const shop = partner || (await ShopPartner.findById(assessment.shopPartner));
  const subject = worker || (await Worker.findById(assessment.worker));

  assessment.status = 'no_show';
  assessment.noShowMarkedAt = now;
  assessment.noShowMarkedBy = markedBy;
  await assessment.save();

  await releaseSlot(assessment.slot).catch((e) =>
    console.error(`[assessment] failed to release slot ${assessment.slot}:`, e.message)
  );

  if (shop) {
    shop.stats.totalNoShows = (shop.stats.totalNoShows || 0) + 1;
    await shop.save();
  }

  if (!subject) return { noShowCount: 0, suspendedUntil: null, worker: null, partner: shop };

  const block = subject.electricalAssessment;
  block.noShowCount = (block.noShowCount || 0) + 1;
  block.stage = 'awaiting_booking';
  let suspendedUntil = null;
  if (block.noShowCount >= NO_SHOWS_BEFORE_SUSPENSION) {
    suspendedUntil = new Date(now.getTime() + NO_SHOW_SUSPENSION_DAYS * 24 * 60 * 60 * 1000);
    block.bookingSuspendedUntil = suspendedUntil;
  }
  await subject.save();

  await transitionWorker(subject, 'pending_assessment', {
    actor: markedBy === 'system' ? 'system' : markedBy,
    reason: suspendedUntil
      ? `No-show #${block.noShowCount}${shop ? ` at ${shop.shopName}` : ''} — booking suspended for ${NO_SHOW_SUSPENSION_DAYS} days`
      : `No-show${shop ? ` at ${shop.shopName}` : ''} — worker may rebook`,
    assessment: assessment._id,
  });

  notify.pushAssessmentUpdate(subject._id, assessment);
  if (shop) {
    await notify
      .noShow({ worker: subject, partner: shop, assessment, suspendedUntil, noShowCount: block.noShowCount })
      .catch((e) => console.error('[assessment] no-show notifications failed:', e.message));
  }

  return { noShowCount: block.noShowCount, suspendedUntil, worker: subject, partner: shop };
}

/**
 * Withdraw every future slot for a partner and rescue anyone booked into them.
 * Used both when ops terminates/pauses a partner and when the monthly quality
 * job auto-terminates one, so a worker is never left holding a booking at a shop
 * that is no longer in the network.
 *
 * @returns {{slotsWithdrawn:number, assessmentsCancelled:number}}
 */
async function withdrawFutureSlots(partnerId, reason) {
  const Worker = require('../models/Worker');
  const notify = require('./assessmentNotifyService');
  const { transitionWorker } = require('./workerStatusService');

  const partner = await ShopPartner.findById(partnerId);
  const now = new Date();

  const futureSlots = await AssessmentSlot.find({
    shopPartner: partnerId,
    startsAt: { $gt: now },
    cancelledAt: null,
  });
  const slotIds = futureSlots.map((s) => s._id);

  if (slotIds.length) {
    await AssessmentSlot.updateMany(
      { _id: { $in: slotIds } },
      { $set: { cancelledAt: now, cancelledReason: reason, isAvailable: false, capacityRemaining: 0 } }
    );
  }

  // Anyone booked into those slots must be told to rebook.
  const affected = slotIds.length
    ? await WorkerAssessment.find({ slot: { $in: slotIds }, status: { $in: LIVE_STATUSES } })
    : [];

  for (const assessment of affected) {
    try {
      assessment.status = 'cancelled';
      assessment.cancelledAt = now;
      assessment.cancelledBy = 'admin';
      assessment.cancellationReason = reason;
      await assessment.save();

      const worker = await Worker.findById(assessment.worker);
      if (!worker) continue;

      worker.electricalAssessment.stage = 'awaiting_booking';
      await worker.save();
      await transitionWorker(worker, 'pending_assessment', {
        reason: `Assessment slot withdrawn — ${reason}`,
        assessment: assessment._id,
      });
      notify.pushAssessmentUpdate(worker._id, assessment);
      if (partner) {
        await notify.slotWithdrawn({ worker, partner, assessment }).catch(() => {});
      }
    } catch (err) {
      console.error(`[assessment] failed to rescue assessment ${assessment._id}:`, err.message);
    }
  }

  return { slotsWithdrawn: slotIds.length, assessmentsCancelled: affected.length };
}

module.exports = {
  checkEligibility,
  claimSlot,
  releaseSlot,
  bookSlot,
  applyNoShow,
  withdrawFutureSlots,
  LIVE_STATUSES,
};
