const mongoose = require('mongoose');

/**
 * Stores phone OTP records. A document auto-expires via a TTL index once
 * `expiresAt` passes. Used for Screen 1 (login OTP).
 *
 * Records are keyed by (phone, purpose), not phone alone: the same number can be
 * both a worker and a customer, and the two login flows must not overwrite or
 * consume each other's codes.
 */
const otpSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, index: true },
    // Which app requested this code. Defaults to 'worker' so records written
    // before this field existed keep resolving to the worker flow.
    purpose: { type: String, enum: ['worker', 'user'], default: 'worker', index: true },
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
