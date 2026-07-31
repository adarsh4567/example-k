const { getUserStats } = require('./userStatsService');

/**
 * The coupon catalog served to the Offers & Rewards screen.
 *
 * This list used to live in the app's own `lib/catalog.ts`, which meant every
 * customer saw the same offers forever: nothing could be expired, targeted, or
 * withdrawn without shipping a new build, and "first booking only" was a claim in
 * the copy rather than a rule. Serving it fixes all three — the same reasoning
 * that put the service catalog behind GET /api/services.
 *
 * Static data in code, like SERVICE_CATALOG, because that is what it is today. An
 * admin-managed `Coupon` collection is a drop-in replacement for COUPON_CATALOG
 * whenever ops needs to run offers without a deploy; nothing outside this file
 * knows where the rows come from.
 *
 * ── Not yet enforced at booking ──────────────────────────────────────────────
 * This module LISTS coupons and can validate one (`resolveCoupon`), but no
 * booking flow applies a discount yet — request creation still prices off the
 * rate card. Until it does, a coupon is display-only and its `discount` must not
 * be trusted as money. `resolveCoupon` exists so wiring it into createRequest is
 * a single call rather than a rewrite, and so validation lands here rather than
 * being reinvented, client-side, at the till.
 */

// `visibleWhen` decides who sees a coupon. Absent = everyone. It receives the
// stat block from userStatsService, so a rule can only depend on facts we
// already fetch for the hero card — deliberately, to keep listing to one query.
const COUPON_CATALOG = [
  {
    code: 'WELCOME150',
    title: 'Welcome offer',
    detail: '₹150 off your first booking. No minimum.',
    discount: 150,
    minSubtotal: 0,
    // The one rule the old hardcoded list couldn't express: this is the sign-up
    // reward, and it disappears the moment the customer has paid for anything.
    visibleWhen: (stats) => stats.paidBookings === 0,
  },
  {
    code: 'FLAT100',
    title: '₹100 off',
    detail: 'On orders above ₹499.',
    discount: 100,
    minSubtotal: 499,
  },
];

// Only the fields the app renders. `visibleWhen` and the validity window are
// server-side machinery and stay here.
function publicView(coupon) {
  return {
    code: coupon.code,
    title: coupon.title,
    detail: coupon.detail,
    discount: coupon.discount,
    minSubtotal: coupon.minSubtotal,
  };
}

// A coupon may carry `startsAt`/`endsAt` (Date or ISO string) to run for a
// window, and `active:false` to be pulled instantly without deleting the row —
// which matters, because a withdrawn coupon still has to be recognisable if an
// old app build sends it.
function isLive(coupon, now) {
  if (coupon.active === false) return false;
  if (coupon.startsAt && now < new Date(coupon.startsAt)) return false;
  if (coupon.endsAt && now > new Date(coupon.endsAt)) return false;
  return true;
}

/**
 * The coupons this customer should see right now.
 * @returns {Promise<Array<{code,title,detail,discount,minSubtotal}>>}
 */
async function listCouponsForUser(userId, { stats } = {}) {
  // Reuse the caller's stats when it already has them (the profile endpoint
  // does) rather than running the same two aggregations twice.
  const s = stats || (await getUserStats(userId));
  const now = new Date();

  return COUPON_CATALOG
    .filter((c) => isLive(c, now))
    .filter((c) => (typeof c.visibleWhen === 'function' ? c.visibleWhen(s) : true))
    .map(publicView);
}

/**
 * Validate a code a customer is trying to use, against their eligibility and the
 * cart it is being applied to. The single place booking-time redemption should
 * call when it ships — see the note at the top of this file.
 *
 * @returns {Promise<{ok:true, coupon, discount:number} | {ok:false, code:number, reason:string}>}
 */
async function resolveCoupon(userId, rawCode, subtotal, { stats } = {}) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) return { ok: false, code: 422, reason: 'Enter a coupon code' };

  const coupon = COUPON_CATALOG.find((c) => c.code === code);
  // Deliberately the same message for "no such coupon" and "not live" — an
  // unknown code and a withdrawn one are the same thing to the customer, and
  // distinguishing them just tells someone which codes exist.
  if (!coupon || !isLive(coupon, new Date())) {
    return { ok: false, code: 404, reason: 'That coupon code is not valid' };
  }

  const s = stats || (await getUserStats(userId));
  if (typeof coupon.visibleWhen === 'function' && !coupon.visibleWhen(s)) {
    return { ok: false, code: 409, reason: 'This offer is not available on your account' };
  }

  const amount = Number(subtotal) || 0;
  if (amount < coupon.minSubtotal) {
    return { ok: false, code: 409, reason: `This coupon needs a subtotal of at least ₹${coupon.minSubtotal}` };
  }

  return {
    ok: true,
    coupon: publicView(coupon),
    // Never discount below zero, however the rate card moves.
    discount: Math.min(coupon.discount, amount),
  };
}

module.exports = { listCouponsForUser, resolveCoupon, COUPON_CATALOG };
