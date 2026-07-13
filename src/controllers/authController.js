const jwt = require('jsonwebtoken');
const Otp = require('../models/Otp');
const Worker = require('../models/Worker');
const { sendOtpSms } = require('../services/smsService');
const { ok, fail } = require('../utils/response');
const { isValidPhone, isValidOtp } = require('../utils/validators');

const OTP_EXPIRY_MIN = Number(process.env.OTP_EXPIRY_MINUTES || 5);
const RESEND_COOLDOWN = Number(process.env.OTP_RESEND_COOLDOWN_SECONDS || 30);
const MOCK_OTP = process.env.MOCK_OTP || '123456';
const SMS_MODE = process.env.SMS_MODE || 'mock';

function generateCode() {
  if (SMS_MODE === 'mock') return MOCK_OTP;
  // 6-digit random code for real mode.
  return String(Math.floor(100000 + Math.random() * 900000));
}

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

    const existing = await Otp.findOne({ phone });
    if (existing) {
      const since = (Date.now() - new Date(existing.lastSentAt).getTime()) / 1000;
      if (since < RESEND_COOLDOWN) {
        return fail(res, `Please wait ${Math.ceil(RESEND_COOLDOWN - since)}s before requesting a new OTP`, 429);
      }
    }

    const code = generateCode();
    const now = new Date();
    await Otp.findOneAndUpdate(
      { phone },
      {
        phone,
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

    const record = await Otp.findOne({ phone });
    if (!record) return fail(res, 'OTP expired or not requested. Please request a new one', 400);
    if (record.code !== otp) {
      record.attempts += 1;
      await record.save();
      return fail(res, 'Incorrect OTP', 400);
    }

    // OTP correct — consume it.
    await Otp.deleteOne({ phone });

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
