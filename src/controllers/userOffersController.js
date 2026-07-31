const { ok, fail } = require('../utils/response');
const coupons = require('../services/couponService');
const referral = require('../services/referralService');
const { getUserStats } = require('../services/userStatsService');

/**
 * The Offers & Rewards screen: the coupon list and the referral block.
 *
 * Both were hardcoded in the app — the same coupons for everyone forever, and a
 * placeholder referral code (`KAARYO-FRIEND`) shared by every customer. One
 * controller because they are one screen and, in the coupon case, share the
 * eligibility query.
 */

// GET /api/user/coupons
async function listCoupons(req, res, next) {
  try {
    // Fetched once and handed to the service: coupon visibility rules read the
    // same stat block the hero card does, so this stays a single query however
    // many rules the catalog grows.
    const stats = await getUserStats(req.user._id);
    const list = await coupons.listCouponsForUser(req.user._id, { stats });
    return ok(res, { coupons: list }, 'Available offers');
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/user/coupons/validate   { code, subtotal }
 *
 * Lets the cart check a code before booking and show the real discount rather
 * than guessing from a client-side copy of the rules.
 *
 * Note this only VALIDATES — no booking flow deducts a coupon yet, so the
 * discount returned here is not yet reflected in what a request is priced at.
 * See the note at the top of services/couponService.
 */
async function validateCoupon(req, res, next) {
  try {
    const { code, subtotal } = req.body || {};
    const result = await coupons.resolveCoupon(req.user._id, code, subtotal);
    if (!result.ok) return fail(res, result.reason, result.code);
    return ok(res, { coupon: result.coupon, discount: result.discount }, 'Coupon applied');
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/user/referral — the code plus the copy rendered around it.
 *
 * `referralCode` is also on the profile payload, which is what the Account tab
 * reads; this exists so the Offers screen can show the reward amounts and terms
 * without those being hardcoded in the app the way the old placeholder was.
 */
async function getReferral(req, res, next) {
  try {
    const referralCode = await referral.ensureReferralCode(req.user);
    return ok(res, { referralCode, ...referral.referralTerms() }, 'Referral programme');
  } catch (err) {
    next(err);
  }
}

module.exports = { listCoupons, validateCoupon, getReferral };
