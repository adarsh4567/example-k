const mongoose = require('mongoose');

/**
 * Stores phone OTP records. A document auto-expires via a TTL index once
 * `expiresAt` passes. Used for Screen 1 (login OTP).
 */
const otpSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, index: true },
    code: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    lastSentAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// TTL index: Mongo removes the doc automatically at `expiresAt`.
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Otp', otpSchema);
