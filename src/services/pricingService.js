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

module.exports = {
  computePriceBreakdown,
  PLATFORM_COMMISSION_PERCENT,
  CATEGORY_BASE_PRICE,
  DUMMY_CUSTOMER_RATING,
  CURRENCY,
};
