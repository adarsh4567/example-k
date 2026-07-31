const User = require('../models/User');
const UserWalletTransaction = require('../models/UserWalletTransaction');
const { getUserStats } = require('./userStatsService');
const { REFERRAL_ENABLED, REFERRER_REWARD, REFEREE_REWARD } = require('../config/rewardsConfig');

/**
 * "Give ₹150, get ₹150" — the referral programme behind the Offers screen.
 *
 * The block was already in the app, showing a placeholder code (`KAARYO-FRIEND`)
 * with a copy button that did nothing, which is worse than absent: every customer
 * shared the same dead string. This module gives each account a real code and
 * makes the reward actually arrive.
 *
 * ── When the money moves ─────────────────────────────────────────────────────
 * At signup a code only records a LINK (`referredBy`); nothing is credited. Both
 * sides are paid when the invited customer's first booking is captured. Paying at
 * signup would mean minting ₹300 for the cost of one SMS, repeatedly.
 *
 * Crediting is called from the payment-capture paths and must never be able to
 * break one: a referral that fails leaves a paid booking with no reward row,
 * which is recoverable on the next capture, whereas a throw here would lose a
 * confirmed payment. Callers wrap it accordingly, and `creditOnFirstPayment` is
 * idempotent so a retry costs nothing.
 */

// No 0/O/1/I/5/S — codes get read aloud and typed by hand.
const ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXYZ2346789';
const SUFFIX_LENGTH = 4;
const PREFIX_MAX = 8;
const DEFAULT_PREFIX = 'KAARYO';

function randomSuffix() {
  let out = '';
  for (let i = 0; i < SUFFIX_LENGTH; i += 1) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

// 'Akash Tiwary' → 'AKASH'. The name is cosmetic — the suffix carries the
// uniqueness — but it makes a shared code recognisable as coming from a person.
function prefixFor(user) {
  const first = String(user.fullName || '').trim().split(/\s+/)[0] || '';
  const cleaned = first.toUpperCase().replace(/[^A-Z]/g, '').slice(0, PREFIX_MAX);
  return cleaned.length >= 3 ? cleaned : DEFAULT_PREFIX;
}

/**
 * This account's referral code, minting one on first use.
 *
 * Mutates and saves `user`. Safe to call on every profile read: it is a no-op
 * once a code exists, and a code is never reissued even if the customer renames
 * themselves, because by then it may be written down or already shared.
 */
async function ensureReferralCode(user) {
  if (user.referralCode) return user.referralCode;

  const prefix = prefixFor(user);
  // Retry on collision. The unique index is the authority, not this loop — two
  // concurrent profile reads for the same new account can both find no code.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = `${prefix}-${randomSuffix()}`;
    try {
      const claimed = await User.findOneAndUpdate(
        { _id: user._id, referralCode: null },
        { $set: { referralCode: candidate } },
        { new: true }
      );
      // Null means a concurrent call already minted one — use theirs.
      if (!claimed) {
        const fresh = await User.findById(user._id).select('referralCode');
        if (fresh && fresh.referralCode) {
          user.referralCode = fresh.referralCode;
          return user.referralCode;
        }
        continue;
      }
      user.referralCode = claimed.referralCode;
      return user.referralCode;
    } catch (err) {
      // 11000 = someone else holds this exact code. Draw another one.
      if (err.code !== 11000) throw err;
    }
  }

  // Five collisions against a 30^4 space means something is wrong, but a missing
  // referral code must not fail a profile read — the screen just can't share yet.
  console.error('[referral] could not mint a unique code for user', String(user._id));
  return null;
}

/**
 * Resolve a code typed at signup and record the link on the new account.
 *
 * Mutates `newUser` WITHOUT saving — the caller is mid-signup and saves once.
 * Never throws and never blocks the signup: a bad code costs the customer their
 * bonus, and refusing to create the account over it would be a worse trade.
 *
 * @returns {Promise<{applied:boolean, reason?:string, referrer?:object}>}
 */
async function attachReferral(newUser, rawCode) {
  if (!REFERRAL_ENABLED) return { applied: false, reason: 'referrals are disabled' };

  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) return { applied: false, reason: 'no code supplied' };
  // Only ever set on a brand-new account; an existing customer cannot be
  // retro-attributed to someone by logging in with a code.
  if (newUser.referredBy) return { applied: false, reason: 'already referred' };

  const referrer = await User.findOne({ referralCode: code }).select('_id status');
  if (!referrer) return { applied: false, reason: 'unknown code' };
  if (String(referrer._id) === String(newUser._id)) return { applied: false, reason: 'own code' };
  if (referrer.status === 'blocked') return { applied: false, reason: 'referrer blocked' };

  newUser.referredBy = referrer._id;
  newUser.referredByCode = code;
  return { applied: true, referrer };
}

/**
 * Pay both sides, once, when the invited customer's first booking is captured.
 *
 * Idempotent three times over: the `referralCreditedAt` stamp, the "have they
 * actually paid for something" check, and the ledger's unique
 * { source, sourceId, type } index as the database-level backstop. Both rows are
 * keyed to the INVITED account's id — that is the event being rewarded, and it
 * lets one inviter earn once per person they bring in and no more.
 *
 * @returns {Promise<{credited:boolean, reason?:string, amount?:number}>}
 */
async function creditOnFirstPayment(userId) {
  if (!REFERRAL_ENABLED) return { credited: false, reason: 'referrals are disabled' };
  if (!userId) return { credited: false, reason: 'no customer' };

  const user = await User.findById(userId);
  if (!user) return { credited: false, reason: 'user not found' };
  if (!user.referredBy) return { credited: false, reason: 'not referred' };
  if (user.referralCreditedAt) return { credited: false, reason: 'already credited' };

  // Guard the trigger rather than trusting the caller: this only fires on a
  // genuinely captured payment, even if some future code path calls it early.
  const stats = await getUserStats(user._id);
  if (stats.paidBookings < 1) return { credited: false, reason: 'no captured payment yet' };

  const rows = [
    {
      user: user.referredBy,
      type: 'credit',
      amount: REFERRER_REWARD,
      source: 'referral_reward',
      sourceId: user._id,
      note: 'Referral reward · your invite completed their first booking',
    },
    {
      user: user._id,
      type: 'credit',
      amount: REFEREE_REWARD,
      source: 'referral_signup',
      sourceId: user._id,
      note: `Referral bonus · joined with ${user.referredByCode}`,
    },
  ];

  for (const row of rows) {
    try {
      await UserWalletTransaction.create(row);
    } catch (err) {
      // 11000 = this half was already written (a crash between the two inserts,
      // or a concurrent capture). The guard working, not a failure — and the
      // reason the two halves are written independently rather than atomically:
      // a partial pair self-heals on the next call, a thrown pair does not.
      if (err.code !== 11000) throw err;
    }
  }

  // Stamped last: if we die before this, the next capture re-runs and the unique
  // index absorbs the duplicate inserts. The other order would risk paying nobody.
  user.referralCreditedAt = new Date();
  await user.save();

  console.log(
    `🎁 Referral paid · inviter ${user.referredBy} +₹${REFERRER_REWARD} · ` +
      `invitee ${user._id} +₹${REFEREE_REWARD} · code ${user.referredByCode}`
  );

  return { credited: true, amount: REFERRER_REWARD + REFEREE_REWARD };
}

/**
 * Fire-and-forget wrapper for the payment-capture paths. A referral failure must
 * never surface as a failed payment, so this swallows and logs.
 */
async function creditOnFirstPaymentSafe(userId) {
  try {
    return await creditOnFirstPayment(userId);
  } catch (err) {
    console.error('[referral] credit failed for user', String(userId), err.message);
    return { credited: false, reason: err.message };
  }
}

// The copy the Offers screen renders around the code.
function referralTerms() {
  return {
    referrerReward: REFERRER_REWARD,
    refereeReward: REFEREE_REWARD,
    enabled: REFERRAL_ENABLED,
    description:
      `Your friend gets ₹${REFEREE_REWARD} off their first booking. ` +
      `You get ₹${REFERRER_REWARD} once they complete it.`,
  };
}

module.exports = {
  ensureReferralCode,
  attachReferral,
  creditOnFirstPayment,
  creditOnFirstPaymentSafe,
  referralTerms,
};
