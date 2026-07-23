/**
 * Signed one-time link for the trial feedback form. Because there is no
 * customer app, the host gets a link (SMS) rather than an authenticated
 * session. The token is a short-lived JWT scoped to a single trial job.
 *
 * Reuses JWT_SECRET (already used for worker auth). Single-use is enforced at
 * the controller by checking feedback.submittedAt — once feedback lands, the
 * job is done and any further POST with the same token is rejected.
 */

const jwt = require('jsonwebtoken');
const { FEEDBACK_TOKEN_TTL, PUBLIC_BASE_URL } = require('../config/trialConfig');

const PURPOSE = 'trial_feedback';

function sign(trialJobId) {
  return jwt.sign({ jobId: String(trialJobId), purpose: PURPOSE }, process.env.JWT_SECRET, {
    expiresIn: FEEDBACK_TOKEN_TTL,
  });
}

// Returns { ok:true, jobId } or { ok:false, reason }.
function verify(token) {
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.purpose !== PURPOSE || !decoded.jobId) {
      return { ok: false, reason: 'Invalid feedback link' };
    }
    return { ok: true, jobId: decoded.jobId };
  } catch (err) {
    return { ok: false, reason: 'This feedback link is invalid or has expired' };
  }
}

function buildLink(token) {
  return `${PUBLIC_BASE_URL}/api/public/trial-feedback/${token}`;
}

module.exports = { sign, verify, buildLink };
