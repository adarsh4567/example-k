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

// ── Trial ("free trial for users") pricing ──────────────────────────────────
// A trial has its own base price per work (flat default 100; override a single
// category with TRIAL_BASE_PRICE_<CATEGORY>). Economics of the promo:
//   • user SEES & PAYS a discounted fraction of the base (TRIAL_USER_PRICE_PERCENT),
//   • the WORKER keeps the FULL user price — no platform commission on a trial,
//   • the platform credits a % of the worker's earning to the USER's wallet
//     (TRIAL_WALLET_CASHBACK_PERCENT) as a signup reward.
// Example (defaults): base 100 → user pays 60 → worker earns 60 → user wallet +30.
const TRIAL_BASE_PRICE = Number(process.env.TRIAL_BASE_PRICE || 100);
const TRIAL_USER_PRICE_PERCENT = Number(process.env.TRIAL_USER_PRICE_PERCENT || 60);
const TRIAL_WALLET_CASHBACK_PERCENT = Number(process.env.TRIAL_WALLET_CASHBACK_PERCENT || 50);

function trialBasePriceFor(category) {
  const raw = process.env[`TRIAL_BASE_PRICE_${String(category).toUpperCase()}`];
  const n = Number(raw);
  return raw !== undefined && raw !== '' && !Number.isNaN(n) ? n : TRIAL_BASE_PRICE;
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

// Trial "free trial for users" pricing (see the config block above).
// worker keeps the full discounted user price; the user-wallet cashback is
// carried on the breakdown for the user-side (admin panel) to apply.
function computeTrialPrice(category) {
  const basePrice = trialBasePriceFor(category);
  const userPrice = Math.round(basePrice * (TRIAL_USER_PRICE_PERCENT / 100));
  const workerEarning = userPrice; // worker keeps 100% of what the user pays
  const userWalletCredit = Math.round(workerEarning * (TRIAL_WALLET_CASHBACK_PERCENT / 100));
  return {
    currency: CURRENCY,
    basePrice,                                            // e.g. 100
    userPrice,                                            // e.g. 60 — user sees & pays this
    totalPrice: userPrice,                                // alias → ServiceRequest.pricing.totalPrice
    userDiscountPercent: 100 - TRIAL_USER_PRICE_PERCENT,  // e.g. 40
    platformFeePercent: 0,                                // no commission on a trial
    platformFee: 0,
    workerEarning,                                        // e.g. 60 (full)
    userWalletCreditPercent: TRIAL_WALLET_CASHBACK_PERCENT, // e.g. 50
    userWalletCredit,                                     // e.g. 30 — credited to USER wallet (user side)
  };
}

module.exports = {
  computePriceBreakdown,
  computeTrialPrice,
  PLATFORM_COMMISSION_PERCENT,
  TRIAL_BASE_PRICE,
  TRIAL_USER_PRICE_PERCENT,
  TRIAL_WALLET_CASHBACK_PERCENT,
  CATEGORY_BASE_PRICE,
  DUMMY_CUSTOMER_RATING,
  CURRENCY,
};
