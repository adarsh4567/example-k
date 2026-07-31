const { ok, fail } = require('../utils/response');
const { getUserStats } = require('../services/userStatsService');
const { getCreditsBalance } = require('../services/userWalletService');
const referral = require('../services/referralService');
const { SUPPORT_PHONE, SUPPORT_EMAIL, SUPPORT_HOURS } = require('../config/rewardsConfig');

/**
 * The customer profile the Account tab renders.
 *
 * Started as phone and name. It now also carries the three hero-card figures
 * (credits, jobs done, lifetime spend), the referral code, and the support
 * contact — all of which the app previously hardcoded, and all of which are
 * bundled here rather than given their own endpoints for one reason: the app
 * already calls this on every cold start to revalidate its token. Folding them in
 * costs no extra round trip; four little endpoints would have cost four.
 *
 * The cost is that a profile read now runs three indexed queries instead of
 * zero. That is the right trade for a per-launch call — and if it ever stops
 * being, the split is mechanical (`stats`/`credits` already come from their own
 * services).
 */

const NAME_MAX = 60;

// Mirrors the same helper in profileController (worker side) — "+91 98765 43210".
function formatPhone(phone) {
  if (!phone || phone.length !== 10) return phone || '';
  return `+91 ${phone.slice(0, 5)} ${phone.slice(5)}`;
}

function initial(name) {
  return name && name.trim() ? name.trim()[0].toUpperCase() : '?';
}

/**
 * @param {object} user - a User document (mutated if a referral code gets minted)
 */
async function buildProfilePayload(user) {
  // All independent — one round of I/O, not three.
  const [credits, stats, referralCode] = await Promise.all([
    getCreditsBalance(user._id),
    getUserStats(user._id),
    referral.ensureReferralCode(user),
  ]);

  return {
    id: user._id,
    phone: user.phone,
    phoneFormatted: formatPhone(user.phone),
    phoneVerified: user.phoneVerified,
    fullName: user.fullName || null,
    displayInitial: initial(user.fullName),
    profileCompleted: !!user.fullName,
    status: user.status,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt || null,

    // Spendable reward balance — the SAME number GET /api/user/wallet reports,
    // because both sum the one ledger. The app used to print a ₹150 constant
    // here, so a customer's credits never moved whatever they earned or spent.
    credits,
    currency: 'INR',

    // Server-side booking counts. The app derived these from device-local
    // history, which missed every instant and trial booking and reset on
    // reinstall. See services/userStatsService.
    stats: {
      jobsCompleted: stats.jobsCompleted,
      lifetimeSpend: stats.lifetimeSpend,
    },

    // Null only if minting collided five times (see referralService) — the app
    // should hide the share control rather than render an empty badge.
    referralCode,

    // Served so changing the support number doesn't need an app release.
    support: { phone: SUPPORT_PHONE, email: SUPPORT_EMAIL, hours: SUPPORT_HOURS },
  };
}

// GET /api/user/profile
async function getProfile(req, res, next) {
  try {
    return ok(res, { profile: await buildProfilePayload(req.user) }, 'Profile fetched');
  } catch (err) {
    next(err);
  }
}

// PUT /api/user/profile   { fullName }
async function updateProfile(req, res, next) {
  try {
    const user = req.user;
    const { fullName } = req.body || {};

    if (fullName === undefined) return fail(res, 'fullName is required', 422);
    if (!String(fullName).trim()) return fail(res, 'Full name cannot be empty', 422);
    const trimmed = String(fullName).trim();
    if (trimmed.length > NAME_MAX) return fail(res, `Full name must be under ${NAME_MAX} characters`, 422);

    user.fullName = trimmed;
    await user.save();
    return ok(res, { profile: await buildProfilePayload(user) }, 'Profile updated');
  } catch (err) {
    next(err);
  }
}

module.exports = { getProfile, updateProfile, buildProfilePayload, NAME_MAX };
