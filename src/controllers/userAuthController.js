const jwt = require('jsonwebtoken');
const Otp = require('../models/Otp');
const User = require('../models/User');
const { sendOtpSms } = require('../services/smsService');
const { ok, fail } = require('../utils/response');
const { isValidPhone, isValidOtp } = require('../utils/validators');
const referral = require('../services/referralService');
const { NAME_MAX } = require('./userProfileController');

/**
 * Customer ("user") authentication — phone + OTP, the same mechanism the worker
 * app uses (see authController), against the `User` collection instead of
 * `Worker`. Same env knobs, same mock-OTP behaviour, so both apps behave
 * identically in development.
 *
 * The issued JWT carries `type: 'user'`; middleware/userAuth requires it, and
 * middleware/auth rejects it. That claim is the only thing separating the two
 * token families, since they share JWT_SECRET.
 */

const OTP_PURPOSE = 'user';
const OTP_EXPIRY_MIN = Number(process.env.OTP_EXPIRY_MINUTES || 5);
const RESEND_COOLDOWN = Number(process.env.OTP_RESEND_COOLDOWN_SECONDS || 30);
const MOCK_OTP = process.env.MOCK_OTP || '123456';
const SMS_MODE = process.env.SMS_MODE || 'mock';

function generateCode() {
  if (SMS_MODE === 'mock') return MOCK_OTP;
  return String(Math.floor(100000 + Math.random() * 900000));
}

function signUserToken(user) {
  return jwt.sign({ id: user._id, type: 'user' }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '30d',
  });
}

// Minimal account summary returned alongside the token. The full profile lives
// on GET /api/user/profile; this is just enough for the app to route.
function authUserView(user) {
  return {
    id: user._id,
    phone: user.phone,
    fullName: user.fullName || null,
    profileCompleted: !!user.fullName,
    status: user.status,
  };
}

// POST /api/user/auth/send-otp  { phone }
async function sendOtp(req, res, next) {
  try {
    const { phone } = req.body;
    if (!isValidPhone(phone)) return fail(res, 'Enter a valid 10-digit mobile number', 422);

    // Blocked accounts don't get codes — fail here rather than after they've
    // spent an SMS and typed six digits.
    const existingUser = await User.findOne({ phone });
    if (existingUser && existingUser.status === 'blocked') {
      return fail(res, 'This account has been blocked', 403);
    }

    const existing = await Otp.findOne({ phone, purpose: OTP_PURPOSE });
    if (existing) {
      const since = (Date.now() - new Date(existing.lastSentAt).getTime()) / 1000;
      if (since < RESEND_COOLDOWN) {
        return fail(res, `Please wait ${Math.ceil(RESEND_COOLDOWN - since)}s before requesting a new OTP`, 429);
      }
    }

    const code = generateCode();
    const now = new Date();
    await Otp.findOneAndUpdate(
      { phone, purpose: OTP_PURPOSE },
      {
        phone,
        purpose: OTP_PURPOSE,
        code,
        expiresAt: new Date(now.getTime() + OTP_EXPIRY_MIN * 60 * 1000),
        lastSentAt: now,
        attempts: 0,
      },
      { upsert: true, new: true }
    );

    await sendOtpSms(phone, code);
    return ok(res, { cooldownSeconds: RESEND_COOLDOWN }, 'OTP sent successfully');
  } catch (err) {
    next(err);
  }
}

// POST /api/user/auth/resend-otp  { phone }  — same as send; cooldown enforced above.
async function resendOtp(req, res, next) {
  return sendOtp(req, res, next);
}

// POST /api/user/auth/verify-otp  { phone, otp, name?, referralCode? }
// Creates the account on first successful verification — there is no separate
// signup call. `name` is optional here so the app can collect it on the same
// screen as the phone number (one round trip) or afterwards via
// PUT /api/user/profile. `profileCompleted` says whether it still needs asking.
//
// `referralCode` is optional and only ever honoured for a NEW account. A bad or
// unknown code does NOT fail the login: it costs the customer a bonus, and
// refusing to create their account over a mistyped code would be a far worse
// trade. The outcome is reported back in `referral` so the app can say so.
async function verifyOtp(req, res, next) {
  try {
    const { phone, otp, name, referralCode } = req.body;
    if (!isValidPhone(phone)) return fail(res, 'Enter a valid 10-digit mobile number', 422);
    if (!isValidOtp(otp)) return fail(res, 'Enter a valid OTP', 422);

    // Validate the name BEFORE consuming the OTP — otherwise a too-long name
    // would burn the code and force the user to request a new one.
    let cleanName;
    if (name !== undefined && name !== null && String(name).trim() !== '') {
      cleanName = String(name).trim();
      if (cleanName.length > NAME_MAX) {
        return fail(res, `Full name must be under ${NAME_MAX} characters`, 422);
      }
    }

    const record = await Otp.findOne({ phone, purpose: OTP_PURPOSE });
    if (!record) return fail(res, 'OTP expired or not requested. Please request a new one', 400);
    if (record.code !== otp) {
      record.attempts += 1;
      await record.save();
      return fail(res, 'Incorrect OTP', 400);
    }

    // OTP correct — consume it so it can't be replayed.
    await Otp.deleteOne({ phone, purpose: OTP_PURPOSE });

    let user = await User.findOne({ phone });
    const isNewUser = !user;
    let referralResult = { applied: false, reason: 'not a new account' };
    if (!user) {
      user = await User.create({ phone, phoneVerified: true, fullName: cleanName || null });
      // Records the link only — nobody is paid until this account's first
      // booking is captured. See services/referralService.
      referralResult = await referral.attachReferral(user, referralCode);
    } else {
      if (user.status === 'blocked') return fail(res, 'This account has been blocked', 403);
      if (!user.phoneVerified) user.phoneVerified = true;
      // A returning user keeps the name they already have; only fill a blank one.
      if (cleanName && !user.fullName) user.fullName = cleanName;
    }
    user.lastLoginAt = new Date();
    // NOTE: `tokensValidFrom` is deliberately NOT cleared here. The token minted
    // below is newer than any cutoff, so it passes on its own; clearing the
    // cutoff would instead resurrect every token a previous "sign out
    // everywhere" killed — which is the exact scenario (a stolen phone) that the
    // customer signed out to stop.
    await user.save();

    const token = signUserToken(user);
    return ok(
      res,
      {
        token,
        isNewUser,
        // Duplicated at the top level too so the login screen can branch without
        // reaching into `user`.
        profileCompleted: !!user.fullName,
        user: authUserView(user),
        // Only present when a code was actually supplied, so the app can confirm
        // "₹150 bonus applied" or explain why it wasn't.
        ...(referralCode ? { referral: { applied: referralResult.applied, reason: referralResult.reason } } : {}),
      },
      isNewUser ? 'New account created' : 'Welcome back'
    );
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/user/auth/logout — invalidate every token issued to this account.
 *
 * Ordinary sign-out stays LOCAL: the app deletes the token and stops sending it,
 * and needs no server call for that. This endpoint exists for the case local
 * sign-out cannot cover — a lost or stolen phone, where the token is still out
 * there and stays valid for the rest of its 30 days.
 *
 * Implemented as a `tokensValidFrom` cutoff on the account rather than a
 * blacklist of token strings. A blacklist needs its own store, its own expiry
 * sweeper, and a lookup on every authenticated request; the cutoff is one field
 * compared against the JWT's `iat` in middleware that has already loaded the
 * account anyway. It also revokes ALL of the customer's devices at once, which
 * is what "my phone was stolen" actually calls for.
 *
 * Idempotent, and safe to call with an already-dead token — the middleware
 * rejects that before it gets here, which is the correct answer either way.
 */
async function logout(req, res, next) {
  try {
    req.user.tokensValidFrom = new Date();
    await req.user.save();
    return ok(res, { signedOutAt: req.user.tokensValidFrom }, 'Signed out on all devices');
  } catch (err) {
    next(err);
  }
}

module.exports = { sendOtp, resendOtp, verifyOtp, logout, signUserToken, authUserView };
