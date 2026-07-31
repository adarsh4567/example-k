/**
 * Pricing for on-demand service requests.
 *
 * DUMMY PRICING: a fixed rate card per category, no real dynamic-pricing engine
 * yet (no surge, no item-level quoting). Each category's price is read from
 * .env (CATEGORY_PRICE_<CATEGORY_KEY>) so it can be tuned without a code
 * change; unset/invalid values fall back to the hardcoded defaults below.
 * Swap CATEGORY_BASE_PRICE for a real pricing model later —
 * computePriceBreakdown() is the only call site.
 */

const PLATFORM_COMMISSION_PERCENT = Number(process.env.PLATFORM_COMMISSION_PERCENT || 10);
const CURRENCY = 'INR';
const DEFAULT_PRICE = Number(process.env.CATEGORY_PRICE_DEFAULT || 300);

// ── Trial ("discounted trial job") pricing ──────────────────────────────────
// A trial is a deliberate loss-leader: it gets a trainee worker through their
// onboarding trial while giving a customer a cheap first job. Three numbers:
//
//   basePrice   what the work is nominally worth — shown struck through (110)
//   userPrice   what the customer actually pays  — an ABSOLUTE amount (100)
//   reward      credited back to the customer's wallet, % of userPrice (40% → 40)
//
// and one rule: the WORKER KEEPS THE FULL userPrice. No platform commission on a
// trial. So the platform collects 100, pays the worker 100 and hands 40 back as a
// reward — a net ₹40 cost per trial, which is the customer-acquisition spend.
//
// `userPrice` is configured as an absolute amount, not a percentage of the base,
// because the two are set independently by the business: 110 → 100 is not a round
// percentage (it's 9.09%), and quoting a price derived from a rounded percentage
// would make the displayed "you save ₹X" disagree with the amount charged.
// TRIAL_USER_PRICE_PERCENT is still honoured as a fallback when no absolute price
// is configured, so older .env files keep working.
const TRIAL_BASE_PRICE = Number(process.env.TRIAL_BASE_PRICE || 110);
const TRIAL_USER_PRICE = process.env.TRIAL_USER_PRICE;
const TRIAL_USER_PRICE_PERCENT = Number(process.env.TRIAL_USER_PRICE_PERCENT || 60);
const TRIAL_REWARD_PERCENT = Number(
  // TRIAL_WALLET_CASHBACK_PERCENT is the pre-rename name; still read so an
  // existing .env doesn't silently change the reward to the new default.
  process.env.TRIAL_REWARD_PERCENT || process.env.TRIAL_WALLET_CASHBACK_PERCENT || 40
);

// Per-category override, falling back to the flat default. Same lookup shape as
// the regular rate card's CATEGORY_PRICE_<CATEGORY>.
function envNumberFor(prefix, category, fallback) {
  const raw = process.env[`${prefix}_${String(category).toUpperCase()}`];
  const n = Number(raw);
  return raw !== undefined && raw !== '' && !Number.isNaN(n) ? n : fallback;
}

function trialBasePriceFor(category) {
  return envNumberFor('TRIAL_BASE_PRICE', category, TRIAL_BASE_PRICE);
}

function trialUserPriceFor(category, basePrice) {
  const absolute = envNumberFor('TRIAL_USER_PRICE', category, TRIAL_USER_PRICE);
  const n = Number(absolute);
  if (absolute !== undefined && absolute !== '' && !Number.isNaN(n)) return n;
  // No absolute price configured — fall back to the legacy percentage.
  return Math.round(basePrice * (TRIAL_USER_PRICE_PERCENT / 100));
}

// Hardcoded fallbacks — used only when the matching .env var is unset/invalid,
// so a fresh clone with no .env still boots with sane demo prices.
const DEFAULT_CATEGORY_PRICE = {
  cleaning: 300,
  electrical: 400,
  cooking: 350,
  plumbing: 450,
  carpentry: 500,
  ac_repair: 600,
  painting: 800,
  pest_control: 500,
};

function envPriceFor(category) {
  const raw = process.env[`CATEGORY_PRICE_${category.toUpperCase()}`];
  const n = Number(raw);
  return raw !== undefined && raw !== '' && !Number.isNaN(n) ? n : undefined;
}

// Resolved once at startup: env value if set and valid, else the hardcoded default.
const CATEGORY_BASE_PRICE = Object.keys(DEFAULT_CATEGORY_PRICE).reduce((acc, category) => {
  acc[category] = envPriceFor(category) ?? DEFAULT_CATEGORY_PRICE[category];
  return acc;
}, {});

// Dummy customer rating shown to the worker pre-accept — no customer rating
// system exists yet, so every request carries this same placeholder value.
const DUMMY_CUSTOMER_RATING = 4.6;

function computePriceBreakdown(category) {
  const totalPrice = CATEGORY_BASE_PRICE[category] ?? DEFAULT_PRICE;
  const platformFee = Math.round(totalPrice * (PLATFORM_COMMISSION_PERCENT / 100));
  const workerEarning = totalPrice - platformFee;
  return {
    currency: CURRENCY,
    totalPrice,
    platformFeePercent: PLATFORM_COMMISSION_PERCENT,
    platformFee,
    workerEarning,
  };
}

/**
 * Trial pricing (see the config block above).
 *
 * With the defaults, for cleaning:
 *   basePrice 110 → userPrice 100 (saves ₹10) → worker earns 100 → reward 40
 *
 * `userReward`/`userRewardPercent` are the current names; `userWalletCredit`/
 * `userWalletCreditPercent` are kept as aliases carrying the identical value,
 * because the admin panel and the TrialJob.pricing schema already read those and
 * renaming a persisted field buys nothing.
 */
function computeTrialPrice(category) {
  const basePrice = trialBasePriceFor(category);
  const userPrice = trialUserPriceFor(category, basePrice);
  const workerEarning = userPrice; // worker keeps 100% of what the user pays
  const userReward = Math.round(userPrice * (TRIAL_REWARD_PERCENT / 100));
  const userSavings = Math.max(0, basePrice - userPrice);

  return {
    currency: CURRENCY,
    basePrice,                              // 110 — shown struck through
    userPrice,                              // 100 — user sees & pays this
    totalPrice: userPrice,                  // alias → ServiceRequest.pricing.totalPrice
    userSavings,                            // 10
    userDiscountPercent: basePrice > 0 ? Math.round((userSavings / basePrice) * 100) : 0, // 9
    platformFeePercent: 0,                  // no commission on a trial
    platformFee: 0,
    workerEarning,                          // 100 — the FULL user price
    userRewardPercent: TRIAL_REWARD_PERCENT, // 40
    userReward,                             // 40 — credited to the user's wallet
    // Aliases (admin panel + TrialJob.pricing schema) — same numbers.
    userWalletCreditPercent: TRIAL_REWARD_PERCENT,
    userWalletCredit: userReward,
  };
}

module.exports = {
  computePriceBreakdown,
  computeTrialPrice,
  PLATFORM_COMMISSION_PERCENT,
  TRIAL_BASE_PRICE,
  TRIAL_USER_PRICE_PERCENT,
  TRIAL_REWARD_PERCENT,
  CATEGORY_BASE_PRICE,
  DUMMY_CUSTOMER_RATING,
  CURRENCY,
};
