const mongoose = require('mongoose');

/**
 * A customer ("user") of the Kaaryo app — the person who books a service.
 *
 * Deliberately minimal: a phone number and a name. That is the entire signup.
 * No email, address, gender or photo — those get added when a screen actually
 * needs them, not speculatively.
 *
 * Kept separate from `Worker` even though both are phone-first accounts
 * authenticated by the same OTP mechanism: the two have unrelated lifecycles
 * (a worker has onboarding, documents, trials, approval status; a user has a
 * name) and one phone number may legitimately be both. Separate collections
 * mean neither pipeline can pollute the other.
 */

const USER_STATUS = ['active', 'blocked'];

const userSchema = new mongoose.Schema(
  {
    // The phone number IS the account — unique, and the only credential
    // (proved by OTP).
    phone: { type: String, required: true, unique: true, index: true },
    phoneVerified: { type: Boolean, default: false },

    // The only profile detail collected. Null until the user supplies it, which
    // may happen in the same call as OTP verification or straight after.
    fullName: { type: String, default: null },

    // Operational, never user-supplied.
    status: { type: String, enum: USER_STATUS, default: 'active', index: true },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true }
);

userSchema.statics.STATUS = USER_STATUS;

module.exports = mongoose.model('User', userSchema);
