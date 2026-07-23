/**
 * The trial-job decision engine — a PURE function, unit-testable in isolation
 * (see scripts/testTrialDecision.js). This is the heart of Filter 2.
 *
 * Verdicts:
 *   'fail'         → any hard-fail answer (careless work, felt unsafe, "won't
 *                    book again"). Auto-rejects the worker.
 *   'strong_pass'  → every q1..q8 answer is the positive one AND the customer
 *                    would "definitely" book again. Auto-approves the worker.
 *   'conditional'  → everything else. Held for a human decision (the 5-min
 *                    callback / admin override).
 *
 * The specific hard-fail and positivity rules live in config/trialQuestions.js
 * so the copy and the logic never drift apart.
 */

const { POSITIVITY_KEYS, isPositive, isHardFail } = require('../config/trialQuestions');

function decide(answers = {}) {
  // 1. Any hard-fail answer, anywhere, rejects outright.
  for (const [key, value] of Object.entries(answers)) {
    if (isHardFail(key, value)) return 'fail';
  }

  // 2. Strong pass: all rated questions positive + "definitely book again".
  const allPositive = POSITIVITY_KEYS.every((q) => isPositive(q, answers[q]));
  if (allPositive && answers.q9 === 'yes_definitely') return 'strong_pass';

  // 3. Everything in between needs a human.
  return 'conditional';
}

// Maps a verdict onto the terminal worker status it drives (null = stays put,
// awaiting a manual admin decision).
function outcomeStatusFor(decision) {
  if (decision === 'strong_pass') return 'approved';
  if (decision === 'fail') return 'rejected';
  return null; // conditional
}

module.exports = { decide, outcomeStatusFor };
