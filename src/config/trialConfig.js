/**
 * Runtime configuration for the trial-job filter. Env-overridable (matching the
 * repo's pricingService/dispatchService style); sane defaults so a fresh clone
 * boots without any .env changes. A settings collection can replace this later.
 */

module.exports = {
  // Master switch. When false, admin "approve" keeps its legacy meaning
  // (straight to `approved`) and the trial pipeline is skipped.
  TRIAL_ENABLED: process.env.TRIAL_ENABLED !== 'false',

  // Offer countdown length (how long the worker has to accept), in seconds.
  OFFER_WINDOW_SECONDS: Number(process.env.TRIAL_OFFER_WINDOW_SECONDS) || 90,

  // Customer feedback SLA: reminder at this many minutes past completion…
  FEEDBACK_SLA_MINUTES: Number(process.env.TRIAL_FEEDBACK_SLA_MINUTES) || 30,
  // …and an ops "overdue" flag this many hours past completion.
  FEEDBACK_OVERDUE_HOURS: Number(process.env.TRIAL_FEEDBACK_OVERDUE_HOURS) || 4,

  // Signed feedback-link lifetime (any jsonwebtoken expiresIn string).
  FEEDBACK_TOKEN_TTL: process.env.TRIAL_FEEDBACK_TOKEN_TTL || '48h',

  // Background sweeper cadence (offer expiry + feedback SLA), in seconds.
  SWEEP_INTERVAL_SECONDS: Number(process.env.TRIAL_SWEEP_INTERVAL_SECONDS) || 15,

  // Base URL used to build the public feedback link that is SMS'd to the host.
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 5000}`,
};
