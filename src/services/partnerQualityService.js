/**
 * Partner quality scoring — the mechanism that catches shop owners who rubber-
 * stamp everyone instead of genuinely assessing them, without any manual
 * monitoring. Runs monthly (see assessmentJobsService).
 *
 * For each active partner it looks at the workers that partner APPROVED over the
 * look-back window and asks how those workers actually performed on the platform:
 *
 *   base score                                        100
 *   − 5  per approved worker who drew a complaint
 *   − 10 per approved worker who was removed from the platform
 *   + 2  per approved worker rating >= QUALITY_GOOD_WORKER_RATING
 *   clamped to 0..100
 *
 * Score < QUALITY_PAUSE_THRESHOLD     → partner auto-paused
 * Score < QUALITY_TERMINATE_THRESHOLD → partner auto-terminated (future slots
 *                                        withdrawn, booked workers told to rebook)
 *
 * COMPLAINT PROXY: this codebase has no complaints collection yet. Until one
 * exists, "drew a complaint" is approximated by a low average rating
 * (rating <= COMPLAINT_RATING_THRESHOLD, ignoring unrated workers) and "removed
 * from the platform" by worker.status === 'rejected'. Both are isolated in
 * classifyWorker() below — swap that one function when a real complaints model
 * lands and every score, snapshot and auto-action follows.
 */

const ShopPartner = require('../models/ShopPartner');
const WorkerAssessment = require('../models/WorkerAssessment');
const Worker = require('../models/Worker');
const booking = require('./assessmentBookingService');
const notify = require('./assessmentNotifyService');
const {
  QUALITY_LOOKBACK_MONTHS,
  QUALITY_PAUSE_THRESHOLD,
  QUALITY_TERMINATE_THRESHOLD,
  QUALITY_GOOD_WORKER_RATING,
} = require('../config/assessmentConfig');

// Rating at or below which an approved worker is counted as having drawn a complaint.
const COMPLAINT_RATING_THRESHOLD = Number(process.env.ASSESSMENT_COMPLAINT_RATING) || 3.0;

// First day of the month containing `date`, at UTC midnight — the snapshot key.
function monthKey(date = new Date()) {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
}

// The single place that decides what "complaint" and "removed" mean.
function classifyWorker(worker) {
  const rating = typeof worker.rating === 'number' ? worker.rating : null;
  return {
    removed: worker.status === 'rejected',
    complained: rating !== null && rating <= COMPLAINT_RATING_THRESHOLD,
    good: rating !== null && rating >= QUALITY_GOOD_WORKER_RATING,
    rating,
  };
}

/**
 * Compute (but do not persist) this partner's snapshot for a month.
 * @returns the snapshot object
 */
async function computeSnapshot(partnerId, month = monthKey()) {
  const since = new Date(month);
  since.setUTCMonth(since.getUTCMonth() - QUALITY_LOOKBACK_MONTHS);

  // Every decided assessment this partner conducted in the window.
  const decided = await WorkerAssessment.find({
    shopPartner: partnerId,
    finalDecisionAt: { $gte: since },
    finalDecision: { $in: ['approved', 'rejected'] },
  }).select('worker finalDecision');

  const approvedIds = decided.filter((a) => a.finalDecision === 'approved').map((a) => a.worker);
  const rejectedCount = decided.length - approvedIds.length;

  const approvedWorkers = approvedIds.length
    ? await Worker.find({ _id: { $in: approvedIds } }).select('rating status jobsCompleted')
    : [];

  let complaints = 0;
  let removed = 0;
  let goodWorkers = 0;
  const ratings = [];

  for (const worker of approvedWorkers) {
    const c = classifyWorker(worker);
    if (c.removed) removed += 1;
    if (c.complained) complaints += 1;
    if (c.good) goodWorkers += 1;
    if (c.rating !== null) ratings.push(c.rating);
  }

  const avgRating = ratings.length
    ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 100) / 100
    : null;

  const raw = 100 - complaints * 5 - removed * 10 + goodWorkers * 2;
  const partnerQualityScore = Math.max(0, Math.min(100, raw));

  return {
    month,
    totalWorkersAssessed: decided.length,
    totalWorkersApproved: approvedIds.length,
    totalWorkersRejected: rejectedCount,
    avgRatingOfApprovedWorkers: avgRating,
    workersWhoCausedComplaints: complaints,
    partnerQualityScore,
    createdAt: new Date(),
  };
}

/**
 * Compute, persist and act on one partner's score.
 * Idempotent: re-running for the same month replaces that month's snapshot
 * rather than appending a duplicate.
 */
async function scorePartner(partnerId, month = monthKey()) {
  const partner = await ShopPartner.findById(partnerId);
  if (!partner) return null;

  const snapshot = await computeSnapshot(partnerId, month);

  // Upsert the snapshot for this month.
  const existingIndex = (partner.qualityHistory || []).findIndex(
    (s) => new Date(s.month).getTime() === snapshot.month.getTime()
  );
  if (existingIndex >= 0) partner.qualityHistory[existingIndex] = snapshot;
  else partner.qualityHistory.push(snapshot);

  partner.stats.partnerQualityScore = snapshot.partnerQualityScore;
  partner.stats.averageDownstreamRating = snapshot.avgRatingOfApprovedWorkers;

  // Auto-actions. Only ever applied to a partner who is currently active — ops
  // manually reactivating a partner must not be undone by a stale score, and a
  // terminated partner is never silently downgraded again.
  let action = null;
  if (partner.status === 'active' && snapshot.totalWorkersAssessed > 0) {
    if (snapshot.partnerQualityScore < QUALITY_TERMINATE_THRESHOLD) action = 'terminated';
    else if (snapshot.partnerQualityScore < QUALITY_PAUSE_THRESHOLD) action = 'paused';
  }

  if (action) {
    partner.status = action;
    partner.autoActionedAt = new Date();
    partner.autoActionReason = `Quality score ${snapshot.partnerQualityScore} — auto-${action}`;
  }

  await partner.save();

  if (action) {
    // A terminated partner's future slots must not stay bookable.
    if (action === 'terminated') {
      await booking
        .withdrawFutureSlots(partner._id, partner.autoActionReason)
        .catch((e) => console.error(`[assessment-quality] slot withdrawal failed:`, e.message));
    }
    await notify
      .partnerAutoActioned({ partner, action, score: snapshot.partnerQualityScore })
      .catch(() => {});
  }

  return { partner, snapshot, action };
}

/**
 * Score every active partner for the current month. Idempotent, so the daily
 * sweeper can call it freely — it only does real work once per partner per month
 * unless `force` is set.
 */
async function runMonthly({ force = false } = {}) {
  const month = monthKey();
  // Include paused partners: their score should keep updating so ops can see a
  // recovery. Terminated partners are left alone.
  const partners = await ShopPartner.find({ status: { $in: ['active', 'paused'] } }).select(
    '_id qualityHistory'
  );

  const results = { scored: 0, paused: 0, terminated: 0, skipped: 0 };

  for (const p of partners) {
    const alreadyDone = (p.qualityHistory || []).some(
      (s) => new Date(s.month).getTime() === month.getTime()
    );
    if (alreadyDone && !force) {
      results.skipped += 1;
      continue;
    }
    try {
      const outcome = await scorePartner(p._id, month);
      results.scored += 1;
      if (outcome && outcome.action === 'paused') results.paused += 1;
      if (outcome && outcome.action === 'terminated') results.terminated += 1;
    } catch (err) {
      console.error(`[assessment-quality] scoring failed for partner ${p._id}:`, err.message);
    }
  }

  if (results.scored) {
    console.log(
      `📊 [assessment-quality] scored ${results.scored} partner(s) for ${month.toISOString().slice(0, 7)} ` +
        `· auto-paused ${results.paused} · auto-terminated ${results.terminated}`
    );
  }
  return results;
}

module.exports = {
  monthKey,
  classifyWorker,
  computeSnapshot,
  scorePartner,
  runMonthly,
  COMPLAINT_RATING_THRESHOLD,
};
