/**
 * Runtime configuration for Filter 3: the in-person electrical shop assessment.
 *
 * Env-overridable (matching trialConfig/pricingService style) with sane defaults
 * so a fresh clone boots without any .env changes.
 */

module.exports = {
  // Master switch. When false, the sweeper is not started and electricians fall
  // back to the normal (trial) pipeline on application approval.
  ASSESSMENT_ENABLED: process.env.ASSESSMENT_ENABLED !== 'false',

  // The worker category this filter applies to (a key in services/serviceCatalog).
  ASSESSMENT_CATEGORY: process.env.ASSESSMENT_CATEGORY || 'electrical',

  // ── Slot search ────────────────────────────────────────────────────────────
  // Outer bound for the "slots near me" geo query, in km.
  SLOT_SEARCH_MAX_RADIUS_KM: Number(process.env.ASSESSMENT_SLOT_RADIUS_KM) || 25,
  // Default look-ahead window for available slots, in days.
  SLOT_SEARCH_DEFAULT_DAYS: Number(process.env.ASSESSMENT_SLOT_DAYS) || 7,
  // Slot length used when only a start time is supplied, in minutes.
  SLOT_DURATION_MINUTES: Number(process.env.ASSESSMENT_SLOT_DURATION_MINUTES) || 60,

  // ── Check-in ───────────────────────────────────────────────────────────────
  // The worker must be within this many metres of the shop to check in.
  CHECKIN_RADIUS_METERS: Number(process.env.ASSESSMENT_CHECKIN_RADIUS_M) || 500,
  // Check-in opens this many minutes before the slot start…
  CHECKIN_OPENS_MINUTES_BEFORE: Number(process.env.ASSESSMENT_CHECKIN_OPENS_MIN) || 30,
  // …and closes this many minutes after the slot start (late arrivals).
  CHECKIN_CLOSES_MINUTES_AFTER: Number(process.env.ASSESSMENT_CHECKIN_CLOSES_MIN) || 60,

  // ── Cancellation / no-show policy ──────────────────────────────────────────
  // A worker may only self-cancel if the slot is at least this far away, in hours.
  CANCEL_CUTOFF_HOURS: Number(process.env.ASSESSMENT_CANCEL_CUTOFF_HOURS) || 24,
  // Nth cancellation that flags the worker's profile for admin review.
  CANCELLATIONS_BEFORE_FLAG: Number(process.env.ASSESSMENT_CANCEL_FLAG_AT) || 2,
  // A shop owner may mark no-show this many minutes after the slot start.
  NO_SHOW_GRACE_MINUTES: Number(process.env.ASSESSMENT_NO_SHOW_GRACE_MIN) || 15,
  // Number of no-shows that suspends booking…
  NO_SHOWS_BEFORE_SUSPENSION: Number(process.env.ASSESSMENT_NO_SHOW_LIMIT) || 2,
  // …and how long that suspension lasts, in days.
  NO_SHOW_SUSPENSION_DAYS: Number(process.env.ASSESSMENT_NO_SHOW_SUSPENSION_DAYS) || 15,
  // Cooldown before a rejected worker may reapply, in days.
  REAPPLY_COOLDOWN_DAYS: Number(process.env.ASSESSMENT_REAPPLY_COOLDOWN_DAYS) || 30,

  // ── Shop owner payouts (₹) ─────────────────────────────────────────────────
  PAYMENT_UPFRONT: Number(process.env.ASSESSMENT_PAYMENT_UPFRONT) || 300,
  PAYMENT_DEFERRED: Number(process.env.ASSESSMENT_PAYMENT_DEFERRED) || 200,
  // Jobs the assessed worker must complete before the deferred half is released.
  DEFERRED_PAYMENT_JOB_THRESHOLD: Number(process.env.ASSESSMENT_DEFERRED_JOBS) || 10,

  // ── Feedback link + SLA ────────────────────────────────────────────────────
  // Signed feedback-link lifetime is derived from the slot end time; this is the
  // grace period added on top (hours). See services/assessmentTokenService.
  FEEDBACK_TOKEN_GRACE_HOURS: Number(process.env.ASSESSMENT_TOKEN_GRACE_HOURS) || 24,
  // Nudge the shop owner if feedback is still missing this long after check-in.
  FEEDBACK_SLA_MINUTES: Number(process.env.ASSESSMENT_FEEDBACK_SLA_MINUTES) || 90,
  // Flag ops if feedback is still missing this many hours after check-in.
  FEEDBACK_OVERDUE_HOURS: Number(process.env.ASSESSMENT_FEEDBACK_OVERDUE_HOURS) || 6,

  // ── Partner quality scoring ────────────────────────────────────────────────
  // Look-back window for the monthly quality calculation, in months.
  QUALITY_LOOKBACK_MONTHS: Number(process.env.ASSESSMENT_QUALITY_LOOKBACK_MONTHS) || 3,
  // Score at or below which a partner is auto-paused…
  QUALITY_PAUSE_THRESHOLD: Number(process.env.ASSESSMENT_QUALITY_PAUSE_BELOW) || 60,
  // …and auto-terminated.
  QUALITY_TERMINATE_THRESHOLD: Number(process.env.ASSESSMENT_QUALITY_TERMINATE_BELOW) || 40,
  // A worker with a rating at/above this earns the partner bonus points.
  QUALITY_GOOD_WORKER_RATING: Number(process.env.ASSESSMENT_QUALITY_GOOD_RATING) || 4.5,

  // ── Background sweeper ─────────────────────────────────────────────────────
  // Cadence for the assessment sweeper (no-show detection + feedback SLA), seconds.
  SWEEP_INTERVAL_SECONDS: Number(process.env.ASSESSMENT_SWEEP_INTERVAL_SECONDS) || 60,
  // Cadence for the slower daily/monthly tasks (deferred payouts + quality), seconds.
  DAILY_SWEEP_INTERVAL_SECONDS: Number(process.env.ASSESSMENT_DAILY_SWEEP_SECONDS) || 3600,

  // Minutes east of UTC used to interpret the date + wall-clock times an admin
  // enters when creating slots. Default: IST (+5:30).
  TZ_OFFSET_MINUTES: Number(process.env.ASSESSMENT_TZ_OFFSET_MINUTES) || 330,

  // Base URL used to build the public feedback link SMS'd to the shop owner.
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 5000}`,
};
