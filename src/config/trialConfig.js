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

  // ── Customer-app trial booking ───────────────────────────────────────────
  // A customer can book a discounted trial job themselves, which finds a worker
  // waiting for their onboarding trial. Independent of TRIAL_ENABLED so the
  // customer-facing offer can be pulled without disabling the admin pipeline.
  USER_TRIAL_ENABLED: process.env.USER_TRIAL_ENABLED !== 'false',

  // Trials are CLEANING ONLY. Electricians don't do a trial job at all — they go
  // through the in-person shop assessment (Filter 3), which is why they never
  // reach `pending_trial`. Other trades (plumbing, carpentry…) do reach it, but
  // the customer-facing trial offer is deliberately scoped to cleaning: it's the
  // one trade with enough trial supply to make the promo dependable.
  USER_TRIAL_CATEGORY: process.env.USER_TRIAL_CATEGORY || 'cleaning',

  // How many `pending_trial` workers one booking may be offered to, in order of
  // distance. The offer goes to ONE worker at a time — a trial is a directed job,
  // not a broadcast — and rolls to the next candidate when one declines or lets
  // the countdown lapse. Worst-case search time is
  // MAX_CANDIDATES × OFFER_WINDOW_SECONDS (3 × 90s = 4.5 min by default).
  USER_TRIAL_MAX_CANDIDATES: Number(process.env.USER_TRIAL_MAX_CANDIDATES) || 3,

  // Outer bound for the candidate geo query, km. A candidate must ALSO be within
  // their own declared travel radius of the customer (see userTrialService).
  USER_TRIAL_SEARCH_RADIUS_KM: Number(process.env.USER_TRIAL_SEARCH_RADIUS_KM) || 15,

  // Lifetime cap on discounted trials per customer account. The promo runs at a
  // deliberate loss (₹40 reward per trial with default pricing), so it is capped
  // at one by default. Raising this is purely a config change — the flow itself
  // has no single-use assumption baked in.
  USER_TRIAL_MAX_PER_USER: Number(process.env.USER_TRIAL_MAX_PER_USER) || 1,
};
