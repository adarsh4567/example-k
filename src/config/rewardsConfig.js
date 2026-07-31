/**
 * Customer-facing rewards + contact config: the referral programme's amounts and
 * the support details the Account tab renders.
 *
 * Env-overridable with sane defaults, matching the trialConfig/dispatchConfig
 * style, so a fresh clone boots without .env changes. These are the numbers the
 * app used to hardcode; serving them means ops can change a reward or a support
 * phone number without shipping a new app build.
 */

module.exports = {
  // ── Referrals ────────────────────────────────────────────────────────────
  // Master switch. When false the referral code is still generated and returned
  // (it costs nothing and keeps codes stable), but no reward is ever credited
  // and a code supplied at signup is ignored rather than rejected — pulling the
  // promo must not start failing logins.
  REFERRAL_ENABLED: process.env.REFERRAL_ENABLED !== 'false',

  // What each side gets, in INR, credited to the reward wallet when the referred
  // customer's FIRST booking is paid for. Denormalised onto the ledger row at
  // credit time, so changing these can never rewrite history.
  REFERRER_REWARD: Number(process.env.REFERRAL_REFERRER_REWARD) || 150,
  REFEREE_REWARD: Number(process.env.REFERRAL_REFEREE_REWARD) || 150,

  // ── Support contact (Account tab → "Talk to support") ────────────────────
  SUPPORT_PHONE: process.env.SUPPORT_PHONE || '1800-000-000',
  SUPPORT_EMAIL: process.env.SUPPORT_EMAIL || 'care@kaaryo.in',
  SUPPORT_HOURS: process.env.SUPPORT_HOURS || '7 AM – 11 PM, all days',
};
