/**
 * The assessment scoring engine — a PURE function, unit-testable in isolation
 * (see scripts/testAssessmentScore.js). Mirrors trialDecisionService.
 *
 * IMPORTANT: unlike the trial-job engine, this one is ADVISORY ONLY. It never
 * transitions a worker. Every assessment gets an explicit admin decision; the
 * engine exists to sort the review queue and to make a safety failure
 * impossible to miss.
 *
 * Preliminary score (0..100) is the weighted sum defined in
 * config/assessmentQuestions:
 *   tool handling 25% + repair quality 35% + sensible questions 15%
 *   + would-hire-in-shop 25%
 *
 * Recommendation:
 *   'reject'  → safety failure, or the shop owner said do_not_onboard
 *   'approve' → score at/above the approve threshold AND owner said onboard
 *   'review'  → everything else (a human decides, which is the default anyway)
 */

const {
  ASSESSMENT_FIELDS,
  FIELD_BY_KEY,
  WEIGHTED_KEYS,
  SAFETY_KEY,
} = require('../config/assessmentQuestions');

// Score at/above which the engine is willing to say "approve" — provided the
// shop owner also recommended onboarding.
const APPROVE_THRESHOLD = Number(process.env.ASSESSMENT_APPROVE_THRESHOLD) || 70;

// Fraction (0..1) of its weight that one field earned, or null if unanswered.
function fractionFor(field, value) {
  if (value === undefined || value === null) return null;

  if (field.type === 'boolean') return value ? 1 : 0;

  if (field.type === 'rating') {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    // Linear min..max → 0..1. A floor of `min` scores 0, not "1/5 of the marks".
    const clamped = Math.min(field.max, Math.max(field.min, n));
    return (clamped - field.min) / (field.max - field.min);
  }

  if (field.type === 'choice' && field.scoreByValue) {
    const f = field.scoreByValue[value];
    return typeof f === 'number' ? f : null;
  }

  return null;
}

/**
 * Score one feedback submission.
 * @param {object} feedback normalised answers (as produced by validateSubmission)
 * @returns {{preliminaryScore:number, safetyFailed:boolean,
 *            recommendation:'approve'|'review'|'reject', breakdown:object}}
 */
function score(feedback = {}) {
  const safetyField = FIELD_BY_KEY[SAFETY_KEY];
  const safetyAnswer = feedback[SAFETY_KEY];
  // A hard fail is specifically the designated answer — an *unanswered* safety
  // question is not treated as a failure (the form makes it mandatory).
  const safetyFailed =
    safetyAnswer !== undefined &&
    safetyAnswer !== null &&
    safetyAnswer === safetyField.hardFailWhen;

  const breakdown = {};
  let earned = 0;
  let possible = 0;

  for (const key of WEIGHTED_KEYS) {
    const field = FIELD_BY_KEY[key];
    const fraction = fractionFor(field, feedback[key]);
    if (fraction === null) {
      breakdown[key] = { weight: field.weight, answer: feedback[key] ?? null, points: null };
      continue;
    }
    const points = Math.round(fraction * field.weight * 100) / 100;
    earned += points;
    possible += field.weight;
    breakdown[key] = { weight: field.weight, answer: feedback[key], points };
  }

  // Normalise over the weight actually answered, so a partial form still yields
  // a comparable 0..100 figure rather than being silently penalised.
  const preliminaryScore = possible > 0 ? Math.round((earned / possible) * 100) : 0;

  let recommendation;
  if (safetyFailed || feedback.overallRecommendation === 'do_not_onboard') {
    recommendation = 'reject';
  } else if (preliminaryScore >= APPROVE_THRESHOLD && feedback.overallRecommendation === 'onboard') {
    recommendation = 'approve';
  } else {
    recommendation = 'review';
  }

  return {
    preliminaryScore,
    safetyFailed,
    recommendation,
    breakdown: { ...breakdown, earned: Math.round(earned * 100) / 100, possible },
  };
}

// Human-readable one-liner for admin notifications / the queue row.
function summarise(result) {
  const parts = [`score ${result.preliminaryScore}/100`, `engine: ${result.recommendation}`];
  if (result.safetyFailed) parts.unshift('⚠️ SAFETY FAILURE');
  return parts.join(' · ');
}

module.exports = { score, summarise, APPROVE_THRESHOLD, WEIGHTED_FIELDS: ASSESSMENT_FIELDS };
