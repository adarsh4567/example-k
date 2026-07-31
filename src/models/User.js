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

    // ── Referrals ────────────────────────────────────────────────
    // This account's own shareable code, e.g. 'AKASH-K7A2'. Minted lazily the
    // first time it's needed (see services/referralService) rather than at
    // signup, so accounts created before referrals existed get one too — and so
    // a name captured after signup can still shape the code. Once minted it is
    // never regenerated: it may already be written down or forwarded.
    referralCode: { type: String, default: null, unique: true, sparse: true, index: true },

    // Who invited this account, resolved at signup. `referredByCode` keeps the
    // string the customer actually typed even if that code is later reissued or
    // its owner renamed — the account link is `referredBy`, the audit is here.
    referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    referredByCode: { type: String, default: null },
    // Set when both sides have been paid, which happens on this account's first
    // captured payment. Doubles as the "already rewarded" guard.
    referralCreditedAt: { type: Date, default: null },

    // Operational, never user-supplied.
    status: { type: String, enum: USER_STATUS, default: 'active', index: true },
    lastLoginAt: { type: Date, default: null },

    // Cutoff for token validity: any JWT issued before this instant is refused
    // by middleware/userAuth. Null (the norm) means every unexpired token works.
    //
    // This is the whole of "sign out everywhere" — a stateless stand-in for a
    // token blacklist, which would otherwise need its own store and a lookup on
    // every authenticated request. Here the check is free: the middleware has
    // already loaded this document to authorise the call.
    tokensValidFrom: { type: Date, default: null },
  },
  { timestamps: true }
);

userSchema.statics.STATUS = USER_STATUS;

module.exports = mongoose.model('User', userSchema);
