const jwt = require('jsonwebtoken');
const Worker = require('../models/Worker');
const otpService = require('../services/otpService');
const { ok, fail } = require('../utils/response');
const { isValidPhone, isValidOtp } = require('../utils/validators');

function signWorkerToken(worker) {
  return jwt.sign({ id: worker._id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '30d',
  });
}

// POST /api/auth/send-otp  { phone }
async function sendOtp(req, res, next) {
  try {
    const { phone } = req.body;
    if (!isValidPhone(phone)) return fail(res, 'Enter a valid 10-digit mobile number', 422);

    // Scoped to purpose:'worker' — the customer app has its own OTP flow for the
    // same number (see userAuthController); neither may consume the other's code.
    const result = await otpService.issue(phone, 'worker');
    if (!result.ok) return fail(res, result.reason, result.code);
    return ok(res, { cooldownSeconds: result.cooldownSeconds }, 'OTP sent successfully');
  } catch (err) {
    next(err);
  }
}

// POST /api/auth/resend-otp  { phone }  — same as send, cooldown enforced above.
async function resendOtp(req, res, next) {
  return sendOtp(req, res, next);
}

// POST /api/auth/verify-otp  { phone, otp }
async function verifyOtp(req, res, next) {
  try {
    const { phone, otp } = req.body;
    if (!isValidPhone(phone)) return fail(res, 'Enter a valid 10-digit mobile number', 422);
    if (!isValidOtp(otp)) return fail(res, 'Enter a valid OTP', 422);

    const consumed = await otpService.consume(phone, 'worker', otp);
    if (!consumed.ok) return fail(res, consumed.reason, consumed.code);

    // Screen 1 note: check if this number already has an account and redirect accordingly.
    let worker = await Worker.findOne({ phone });
    const isNewUser = !worker;
    if (!worker) {
      worker = await Worker.create({ phone, phoneVerified: true, onboardingStep: 'phone' });
    } else if (!worker.phoneVerified) {
      worker.phoneVerified = true;
      await worker.save();
    }

    const token = signWorkerToken(worker);
    return ok(
      res,
      {
        token,
        isNewUser,
        worker: {
          id: worker._id,
          phone: worker.phone,
          status: worker.status,
          onboardingStep: worker.onboardingStep,
          fullName: worker.fullName || null,
        },
      },
      isNewUser ? 'New account created' : 'Welcome back'
    );
  } catch (err) {
    next(err);
  }
}

module.exports = { sendOtp, resendOtp, verifyOtp };
