const { ok, fail } = require('../utils/response');

/**
 * The customer profile — phone and name, nothing more.
 *
 * The name is normally captured during OTP verification (see userAuthController);
 * this exists so the app can read the account back and let the user rename
 * themselves later.
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

function buildProfilePayload(user) {
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
  };
}

// GET /api/user/profile
async function getProfile(req, res, next) {
  try {
    return ok(res, { profile: buildProfilePayload(req.user) }, 'Profile fetched');
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
    return ok(res, { profile: buildProfilePayload(user) }, 'Profile updated');
  } catch (err) {
    next(err);
  }
}

module.exports = { getProfile, updateProfile, buildProfilePayload, NAME_MAX };
