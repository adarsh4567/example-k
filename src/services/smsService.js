/**
 * SMS / OTP delivery service.
 *
 * MOCK: logs the OTP to the console and always "delivers" successfully.
 * REAL: set SMS_MODE=real in .env and implement sendSms() with your provider
 *       (Twilio, MSG91, Gupshup, etc.). Everything else stays the same.
 */

const MODE = process.env.SMS_MODE || 'mock';

async function sendOtpSms(phone, code) {
  if (MODE === 'real') {
    // ── REAL INTEGRATION GOES HERE ─────────────────────────────
    // e.g. await twilioClient.messages.create({ to: `+91${phone}`, body: `Your Kaaryo OTP is ${code}` });
    throw new Error('SMS_MODE=real but no provider implemented in smsService.js');
  }
  console.log(`📱 [MOCK SMS] OTP for ${phone} is: ${code}`);
  return { delivered: true, provider: 'mock' };
}

async function sendTransactionalSms(phone, message) {
  if (MODE === 'real') {
    throw new Error('SMS_MODE=real but no provider implemented in smsService.js');
  }
  console.log(`📱 [MOCK SMS] to ${phone}: ${message}`);
  return { delivered: true, provider: 'mock' };
}

module.exports = { sendOtpSms, sendTransactionalSms };
