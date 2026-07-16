/**
 * Earnings summary for the worker app's Earnings tab.
 *
 * All date bucketing (week/month/day boundaries) is done in IST (Asia/Kolkata,
 * UTC+5:30, no DST) via plain offset arithmetic — not a timezone library, and
 * not MongoDB's timezone operators (so behavior doesn't depend on the Atlas
 * cluster's tz database). This is safe because India has a single fixed offset.
 *
 * Bucketing is by `completedAt` — a job counts toward the period it finished
 * in, since that's when the worker actually earned the money. Only
 * status === 'completed' jobs count (pending_rating hasn't finished the
 * rating-required flow yet — see the job-rating system).
 */

const ServiceRequest = require('../models/ServiceRequest');
const { PLATFORM_COMMISSION_PERCENT, CURRENCY } = require('./pricingService');

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// The UTC instant corresponding to 00:00:00 IST of the IST calendar day `utcDate` falls in.
function istStartOfDay(utcDate) {
  const shifted = new Date(utcDate.getTime() + IST_OFFSET_MS);
  const midnightShifted = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  return new Date(midnightShifted - IST_OFFSET_MS);
}

// 0=Sun..6=Sat, as read on the IST wall clock.
function istDayOfWeek(utcDate) {
  return new Date(utcDate.getTime() + IST_OFFSET_MS).getUTCDay();
}

function istDateString(utcDate) {
  const shifted = new Date(utcDate.getTime() + IST_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Monday 00:00 IST of the week containing `now`, through the following Monday (exclusive).
function getISTWeekBounds(now) {
  const dow = istDayOfWeek(now);
  const diffToMonday = dow === 0 ? 6 : dow - 1;
  const todayStart = istStartOfDay(now);
  const start = new Date(todayStart.getTime() - diffToMonday * DAY_MS);
  const end = new Date(start.getTime() + 7 * DAY_MS);
  return { start, end };
}

// 1st-of-month 00:00 IST through the start of next month (exclusive).
function getISTMonthBounds(now) {
  const shifted = new Date(now.getTime() + IST_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth();
  const start = new Date(Date.UTC(y, m, 1) - IST_OFFSET_MS);
  const end = new Date(Date.UTC(y, m + 1, 1) - IST_OFFSET_MS);
  return { start, end };
}

const earning = (job) => (job.pricing && job.pricing.workerEarning) || 0;

async function computeEarningsSummary(workerId, period) {
  const now = new Date();
  const week = getISTWeekBounds(now);
  const bounds = period === 'month' ? getISTMonthBounds(now) : week;

  const periodJobs = await ServiceRequest.find({
    acceptedBy: workerId,
    status: 'completed',
    completedAt: { $gte: bounds.start, $lt: bounds.end },
  }).select('completedAt pricing');

  // `days` is always the current Mon-Sun week regardless of `period` — reuse
  // periodJobs when period is already "week" instead of querying twice.
  const weekJobs = period === 'week'
    ? periodJobs
    : await ServiceRequest.find({
      acceptedBy: workerId,
      status: 'completed',
      completedAt: { $gte: week.start, $lt: week.end },
    }).select('completedAt pricing');

  const totalEarned = periodJobs.reduce((sum, j) => sum + earning(j), 0);
  const jobsCount = periodJobs.length;

  // Zero-filled 7-day breakdown, Monday first.
  const days = [];
  for (let i = 0; i < 7; i++) {
    const dayStart = new Date(week.start.getTime() + i * DAY_MS);
    days.push({ date: istDateString(dayStart), day: DAY_LABELS[istDayOfWeek(dayStart)], amount: 0 });
  }
  weekJobs.forEach((j) => {
    const idx = Math.floor((j.completedAt.getTime() - week.start.getTime()) / DAY_MS);
    if (idx >= 0 && idx < 7) days[idx].amount += earning(j);
  });

  // Wallet balance: lifetime earnings, period-independent — there's no
  // withdrawal system yet, so nothing has ever been deducted from it.
  const allTimeJobs = await ServiceRequest.find({
    acceptedBy: workerId,
    status: 'completed',
  }).select('pricing');
  const walletBalance = allTimeJobs.reduce((sum, j) => sum + earning(j), 0);

  return {
    period,
    currency: CURRENCY,
    totalEarned,
    jobsCount,
    walletBalance,
    platformFeePercent: PLATFORM_COMMISSION_PERCENT,
    days,
  };
}

module.exports = { computeEarningsSummary, getISTWeekBounds, getISTMonthBounds, istStartOfDay };
