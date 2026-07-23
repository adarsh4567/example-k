/**
 * Standalone unit tests for the trial decision engine — the one piece that
 * absolutely must be right. No test framework is configured, so this uses
 * node's built-in assert and is run with:  node src/scripts/testTrialDecision.js
 * (or `npm run test:trial`). Exits non-zero on any failure.
 */

const assert = require('assert');
const { decide } = require('../services/trialDecisionService');

// A fully-positive answer set (used as the baseline for mutations below).
const ALL_POSITIVE = {
  q1: 'on_time',
  q2: 'presentable',
  q3: 'polite',
  q4: 'yes',
  q5: 'thorough',
  q6: 'prepared',
  q7: 'good',
  q8: 'comfortable',
  q9: 'yes_definitely',
  q10: 'Great worker.',
};

const cases = [
  ['all positive + definitely → strong_pass', ALL_POSITIVE, 'strong_pass'],

  // Hard fails (each alone must reject, even amid otherwise-perfect answers).
  ['uncomfortable (q8) → fail', { ...ALL_POSITIVE, q8: 'uncomfortable' }, 'fail'],
  ['careless (q5) → fail', { ...ALL_POSITIVE, q5: 'careless' }, 'fail'],
  ['would not book again (q9=no) → fail', { ...ALL_POSITIVE, q9: 'no' }, 'fail'],

  // Conditional: good enough to not fail, not perfect enough to auto-pass.
  ['positive but "maybe" book again → conditional', { ...ALL_POSITIVE, q9: 'yes_maybe' }, 'conditional'],
  ['one non-positive rating (q7 average) → conditional', { ...ALL_POSITIVE, q7: 'average' }, 'conditional'],
  ['slightly late (q1) → conditional', { ...ALL_POSITIVE, q1: 'slightly_late' }, 'conditional'],

  // A hard fail wins even if q9 is definitely.
  ['careless + definitely → fail (hard fail wins)', { ...ALL_POSITIVE, q5: 'careless', q9: 'yes_definitely' }, 'fail'],
];

let passed = 0;
for (const [name, input, expected] of cases) {
  const got = decide(input);
  assert.strictEqual(got, expected, `${name}: expected "${expected}", got "${got}"`);
  console.log(`  ✓ ${name}`);
  passed += 1;
}

console.log(`\n✅ trial decision engine: ${passed}/${cases.length} cases passed`);
