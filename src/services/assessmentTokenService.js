/**
 * Signed link for the shop owner's feedback form. The owner has no app and no
 * account — access is granted purely by the token in the link that is SMS'd /
 * WhatsApp'd to them when a worker books their slot.
 *
 * Mirrors trialTokenService (same JWT_SECRET, same purpose-tagging), with one
 * difference: the expiry is ABSOLUTE, derived from the slot's end time plus a
 * grace period, rather than a fixed TTL from the moment of signing. A link minted
 * at booking time and a link re-minted for a reminder therefore expire together.
 *
 * Single use is enforced at the controller by checking feedback.submittedAt.
 */

const jwt = require('jsonwebtoken');
const { FEEDBACK_TOKEN_GRACE_HOURS, PUBLIC_BASE_URL } = require('../config/assessmentConfig');

const PURPOSE = 'shop_assessment_feedback';

/**
 * Sign a token for one assessment.
 * @param {ObjectId|string} assessmentId
 * @param {Date} slotEndAt the assessment's scheduledEndAt
 */
function sign(assessmentId, slotEndAt) {
  const expiresAtMs =
    new Date(slotEndAt).getTime() + FEEDBACK_TOKEN_GRACE_HOURS * 60 * 60 * 1000;
  // Guard against a slot in the past yielding a negative/zero lifetime, which
  // jsonwebtoken would reject: always leave at least a minute of validity.
  const ttlSeconds = Math.max(60, Math.floor((expiresAtMs - Date.now()) / 1000));

  return jwt.sign(
    { assessmentId: String(assessmentId), purpose: PURPOSE },
    process.env.JWT_SECRET,
    { expiresIn: ttlSeconds }
  );
}

// Returns { ok:true, assessmentId } or { ok:false, reason }.
function verify(token) {
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.purpose !== PURPOSE || !decoded.assessmentId) {
      return { ok: false, reason: 'Invalid feedback link' };
    }
    return { ok: true, assessmentId: decoded.assessmentId };
  } catch (err) {
    return { ok: false, reason: 'This feedback link is invalid or has expired' };
  }
}

// The link the shop owner receives. Matches the path the partner web form is
// built against (see PART 5 of the implementation guide).
function buildLink(token) {
  return `${PUBLIC_BASE_URL}/api/partner/assessment/form/${token}`;
}

module.exports = { sign, verify, buildLink, PURPOSE };
