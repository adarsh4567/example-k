/**
 * Pricing for on-demand service requests.
 *
 * DUMMY PRICING: a fixed rate card per category, no real dynamic-pricing engine
 * yet (no surge, no item-level quoting). Swap CATEGORY_BASE_PRICE for a real
 * pricing model later — computePriceBreakdown() is the only call site.
 */

const PLATFORM_COMMISSION_PERCENT = Number(process.env.PLATFORM_COMMISSION_PERCENT || 10);
const CURRENCY = 'INR';
const DEFAULT_PRICE = 300;

const CATEGORY_BASE_PRICE = {
  cleaning: 300,
  electrical: 400,
  cooking: 350,
  plumbing: 450,
  carpentry: 500,
  ac_repair: 600,
  painting: 800,
  pest_control: 500,
};

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
};
