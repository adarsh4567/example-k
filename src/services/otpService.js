const crypto = require('crypto');
const Otp = require('../models/Otp');
const { sendOtpSms } = require('./smsService');

const OTP_EXPIRY_MIN = Number(process.env.OTP_EXPIRY_MINUTES || 5);
const RESEND_COOLDOWN = Number(process.env.OTP_RESEND_COOLDOWN_SECONDS || 30);
const MAX_ATTEMPTS = Number(process.env.OTP_MAX_ATTEMPTS || 5);
const MOCK_OTP = process.env.MOCK_OTP || '123456';
const SMS_MODE = process.env.SMS_MODE || 'mock';

function generateCode() {
  if (SMS_MODE === 'mock') return MOCK_OTP;
  return String(crypto.randomInt(100000, 1000000));
}

async function issue(phone, purpose) {
  const now = new Date();
  const cooldownBefore = new Date(now.getTime() - RESEND_COOLDOWN * 1000);
  const code = generateCode();

  try {
    await Otp.findOneAndUpdate(
      {
        phone,
        purpose,
        $or: [{ lastSentAt: { $lte: cooldownBefore } }, { lastSentAt: { $exists: false } }],
      },
      {
        $set: {
          phone,
          purpose,
          code,
          expiresAt: new Date(now.getTime() + OTP_EXPIRY_MIN * 60 * 1000),
          lastSentAt: now,
          attempts: 0,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    // With the unique phone+purpose index, a cooldown race becomes a duplicate
    // insert attempt. Report it as rate limiting, not an internal error.
    if (err.code === 11000) {
      return { ok: false, code: 429, reason: `Please wait ${RESEND_COOLDOWN}s before requesting a new OTP` };
    }
    throw err;
  }

  await sendOtpSms(phone, code);
  return { ok: true, cooldownSeconds: RESEND_COOLDOWN };
}

async function consume(phone, purpose, code) {
  const now = new Date();
  // Deleting is the claim: exactly one concurrent verifier can consume a code.
  const consumed = await Otp.findOneAndDelete({
    phone,
    purpose,
    code,
    expiresAt: { $gt: now },
    attempts: { $lt: MAX_ATTEMPTS },
  });
  if (consumed) return { ok: true };

  const record = await Otp.findOne({ phone, purpose }).select('_id expiresAt attempts');
  if (!record || record.expiresAt <= now || record.attempts >= MAX_ATTEMPTS) {
    if (record) await Otp.deleteOne({ _id: record._id });
    return { ok: false, code: 400, reason: 'OTP expired or too many attempts. Please request a new one' };
  }

  const updated = await Otp.findOneAndUpdate(
    { _id: record._id, attempts: { $lt: MAX_ATTEMPTS } },
    { $inc: { attempts: 1 } },
    { new: true }
  );
  if (updated && updated.attempts >= MAX_ATTEMPTS) await Otp.deleteOne({ _id: updated._id });
  return { ok: false, code: 400, reason: 'Incorrect OTP' };
}

module.exports = { issue, consume, MAX_ATTEMPTS, RESEND_COOLDOWN };
