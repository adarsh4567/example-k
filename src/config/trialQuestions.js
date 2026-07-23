/**
 * The 10-question feedback form the trial "host" customer fills in after the
 * worker completes a trial job. This is the single source of truth shared by:
 *   - the public feedback endpoint (renders/validates the form), and
 *   - the decision engine (services/trialDecisionService).
 *
 * NOTE: wording here is placeholder-quality — swap `prompt`/`label` text for the
 * final product copy at any time. The *answer values* and the flags below are
 * what the decision engine depends on, so keep those stable:
 *
 *   positive:  the "good" answer for an all-positive strong-pass check (q1..q8).
 *   hardFail:  choosing this answer alone rejects the worker outright.
 *
 * q9 is the "would you book again" gate (its own values), and q10 is optional
 * free-text — neither is part of the q1..q8 positivity sweep.
 */

const TRIAL_QUESTIONS = [
  {
    key: 'q1',
    prompt: 'Did the worker arrive on time?',
    type: 'single',
    options: [
      { value: 'on_time', label: 'On time', positive: true },
      { value: 'slightly_late', label: 'Slightly late' },
      { value: 'very_late', label: 'Very late' },
    ],
  },
  {
    key: 'q2',
    prompt: 'Was the worker presentable and appropriately dressed?',
    type: 'single',
    options: [
      { value: 'presentable', label: 'Presentable', positive: true },
      { value: 'average', label: 'Average' },
      { value: 'unkempt', label: 'Unkempt' },
    ],
  },
  {
    key: 'q3',
    prompt: 'Was the worker polite and well-mannered?',
    type: 'single',
    options: [
      { value: 'polite', label: 'Polite', positive: true },
      { value: 'neutral', label: 'Neutral' },
      { value: 'rude', label: 'Rude' },
    ],
  },
  {
    key: 'q4',
    prompt: 'Did the worker follow your instructions?',
    type: 'single',
    options: [
      { value: 'yes', label: 'Yes, fully', positive: true },
      { value: 'partially', label: 'Partially' },
      { value: 'no', label: 'No' },
    ],
  },
  {
    key: 'q5',
    prompt: 'How careful and thorough was the work?',
    type: 'single',
    options: [
      { value: 'thorough', label: 'Thorough', positive: true },
      { value: 'acceptable', label: 'Acceptable' },
      { value: 'careless', label: 'Careless', hardFail: true },
    ],
  },
  {
    key: 'q6',
    prompt: 'Did the worker come prepared (equipment/supplies as expected)?',
    type: 'single',
    options: [
      { value: 'prepared', label: 'Prepared', positive: true },
      { value: 'partially', label: 'Partially prepared' },
      { value: 'unprepared', label: 'Unprepared' },
    ],
  },
  {
    key: 'q7',
    prompt: 'Overall quality of the finished work?',
    type: 'single',
    options: [
      { value: 'good', label: 'Good', positive: true },
      { value: 'average', label: 'Average' },
      { value: 'poor', label: 'Poor' },
    ],
  },
  {
    key: 'q8',
    prompt: 'Did you feel comfortable and safe with the worker present?',
    type: 'single',
    options: [
      { value: 'comfortable', label: 'Comfortable', positive: true },
      { value: 'somewhat', label: 'Somewhat' },
      { value: 'uncomfortable', label: 'Uncomfortable', hardFail: true },
    ],
  },
  {
    key: 'q9',
    prompt: 'Would you book this worker again?',
    type: 'single',
    options: [
      { value: 'yes_definitely', label: 'Yes, definitely' },
      { value: 'yes_maybe', label: 'Maybe' },
      { value: 'no', label: 'No', hardFail: true },
    ],
  },
  {
    key: 'q10',
    prompt: 'Any additional comments? (optional)',
    type: 'text',
    optional: true,
  },
];

// ── Derived lookups (built once) ────────────────────────────────────────────
const QUESTION_BY_KEY = TRIAL_QUESTIONS.reduce((acc, q) => {
  acc[q.key] = q;
  return acc;
}, {});

// Questions that feed the "all positive → strong pass" sweep.
const POSITIVITY_KEYS = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8'];

function optionFor(key, value) {
  const q = QUESTION_BY_KEY[key];
  if (!q || !q.options) return null;
  return q.options.find((o) => o.value === value) || null;
}

// Is `value` the designated positive answer for question `key`?
function isPositive(key, value) {
  const opt = optionFor(key, value);
  return !!(opt && opt.positive);
}

// Does `value` trigger an outright fail for question `key`?
function isHardFail(key, value) {
  const opt = optionFor(key, value);
  return !!(opt && opt.hardFail);
}

// Validate a single answer value belongs to the question's allowed options.
function isValidAnswer(key, value) {
  const q = QUESTION_BY_KEY[key];
  if (!q) return false;
  if (q.type === 'text') return true; // free text (any string, incl. empty)
  return q.options.some((o) => o.value === value);
}

module.exports = {
  TRIAL_QUESTIONS,
  QUESTION_BY_KEY,
  POSITIVITY_KEYS,
  isPositive,
  isHardFail,
  isValidAnswer,
};
