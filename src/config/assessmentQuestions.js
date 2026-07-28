/**
 * The feedback form the electrical shop owner fills in after the 45-minute
 * hands-on assessment. Single source of truth shared by:
 *   - the public partner endpoint (renders + validates the form), and
 *   - the scoring engine (services/assessmentScoreService).
 *
 * `page` mirrors the 5-page web-form flow so the front end can render straight
 * from this payload (page 1 is the confirm screen, page 5 is the summary):
 *   page 2 → the safety question, deliberately alone on its own page
 *   page 3 → skill assessment
 *   page 4 → overall assessment
 *
 * Copy (`prompt`, `label`, `help`) is safe to reword at any time. The *keys* and
 * *answer values* are what the scoring engine and the DB depend on — keep those
 * stable.
 *
 * Scoring contract:
 *   weight       → this field's share of the 100-point preliminary score.
 *   hardFailWhen → this answer alone is a critical safety failure.
 *   scoreByValue → for choice fields, the 0..1 fraction of `weight` each value earns.
 * Rating fields score linearly from min..max onto 0..1.
 *
 * Weights total 100: tool handling 25 + repair quality 35 + sensible questions 15
 * + would-hire 25.
 */

const ASSESSMENT_FIELDS = [
  // ── Page 2: the safety question ──────────────────────────────────────────
  {
    key: 'isolatedCircuitBeforeTouching',
    page: 2,
    type: 'boolean',
    required: true,
    prompt:
      'Before touching any wires or electrical components, did the worker switch off the circuit breaker or MCB first?',
    labels: { true: 'Yes, they did', false: 'No, they did not' },
    // A "no" here is a critical safety failure, surfaced to the admin as such.
    hardFailWhen: false,
    warningOnHardFail:
      'This is a critical safety failure. Workers who touch live wires without isolating the circuit first cannot be onboarded on Kaaryo, for the safety of our customers. Are you sure?',
  },

  // ── Page 3: skill assessment ─────────────────────────────────────────────
  {
    key: 'toolHandlingScore',
    page: 3,
    type: 'rating',
    required: true,
    min: 1,
    max: 5,
    weight: 25,
    prompt: 'How would you rate their comfort and familiarity with electrical tools?',
  },
  {
    key: 'repairQualityScore',
    page: 3,
    type: 'rating',
    required: true,
    min: 1,
    max: 5,
    weight: 35,
    prompt: 'How would you rate the quality of the electrical work they completed?',
  },
  {
    key: 'askedSensibleQuestions',
    page: 3,
    type: 'boolean',
    required: true,
    weight: 15,
    prompt:
      'Did the worker ask sensible questions when they were unsure, rather than guessing blindly?',
    labels: { true: 'Yes', false: 'No' },
  },
  {
    key: 'tasksPerformed',
    page: 3,
    type: 'text',
    required: true,
    minLength: 20,
    prompt: 'Briefly describe what tasks the worker did during the session.',
    help: 'At least 20 characters.',
  },

  // ── Page 4: overall assessment ───────────────────────────────────────────
  {
    key: 'wouldHireInShop',
    page: 4,
    type: 'choice',
    required: true,
    weight: 25,
    prompt: 'Would you hire this worker in your own shop?',
    options: [
      { value: 'yes', label: 'Yes' },
      { value: 'maybe', label: 'Maybe' },
      { value: 'no', label: 'No' },
    ],
    scoreByValue: { yes: 1, maybe: 0.5, no: 0 },
  },
  {
    key: 'overallRecommendation',
    page: 4,
    type: 'choice',
    required: true,
    prompt: 'Overall recommendation for Kaaryo',
    options: [
      { value: 'onboard', label: 'Onboard this worker' },
      { value: 'maybe', label: 'I am not sure' },
      { value: 'do_not_onboard', label: 'Do not onboard' },
    ],
  },
  {
    key: 'additionalNotes',
    page: 4,
    type: 'text',
    required: false,
    prompt: 'Any additional comments?',
  },
];

// ── Derived lookups (built once) ─────────────────────────────────────────────
const FIELD_BY_KEY = ASSESSMENT_FIELDS.reduce((acc, f) => {
  acc[f.key] = f;
  return acc;
}, {});

// Fields that carry scoring weight, in engine order.
const WEIGHTED_KEYS = ASSESSMENT_FIELDS.filter((f) => f.weight).map((f) => f.key);

// The single safety-critical field.
const SAFETY_KEY = 'isolatedCircuitBeforeTouching';

/**
 * Coerce a booleanish submission value. The API guide documents these fields as
 * booleans while the web form presents Yes/No buttons, so accept both shapes
 * (plus the string forms an HTML form naturally sends) rather than 422-ing on a
 * cosmetic difference.
 * Returns true/false, or null if unrecognised.
 */
function coerceBoolean(value) {
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (['true', 'yes', '1', 'y'].includes(s)) return true;
  if (['false', 'no', '0', 'n'].includes(s)) return false;
  return null;
}

// `wouldHireInShop` is documented as a boolean but rendered as Yes/Maybe/No.
// Accept either and normalise onto the three-value enum.
function coerceChoice(field, value) {
  const allowed = field.options.map((o) => o.value);
  const s = String(value).trim().toLowerCase();
  if (allowed.includes(s)) return s;
  if (field.key === 'wouldHireInShop') {
    const b = coerceBoolean(value);
    if (b === true) return 'yes';
    if (b === false) return 'no';
  }
  return null;
}

/**
 * Validate + normalise a raw submission body.
 * @returns {{ok: true, value: object} | {ok: false, message: string}}
 */
function validateSubmission(raw = {}) {
  const value = {};

  for (const field of ASSESSMENT_FIELDS) {
    const provided = raw[field.key];
    const missing = provided === undefined || provided === null || provided === '';

    if (missing) {
      if (!field.required) {
        if (field.type === 'text') value[field.key] = '';
        continue;
      }
      return { ok: false, message: `Missing answer for "${field.prompt}"` };
    }

    if (field.type === 'boolean') {
      const b = coerceBoolean(provided);
      if (b === null) return { ok: false, message: `Answer ${field.key} must be yes or no` };
      value[field.key] = b;
      continue;
    }

    if (field.type === 'rating') {
      const n = Number(provided);
      if (!Number.isInteger(n) || n < field.min || n > field.max) {
        return {
          ok: false,
          message: `${field.key} must be a whole number between ${field.min} and ${field.max}`,
        };
      }
      value[field.key] = n;
      continue;
    }

    if (field.type === 'choice') {
      const c = coerceChoice(field, provided);
      if (c === null) {
        const allowed = field.options.map((o) => o.value).join(' / ');
        return { ok: false, message: `${field.key} must be one of: ${allowed}` };
      }
      value[field.key] = c;
      continue;
    }

    // text
    const text = String(provided).trim();
    if (field.minLength && text.length < field.minLength) {
      return {
        ok: false,
        message: `${field.key} must be at least ${field.minLength} characters (got ${text.length})`,
      };
    }
    value[field.key] = text;
  }

  return { ok: true, value };
}

// Public shape of the form (drops internal scoring flags so the weights and
// hard-fail rules are never exposed to the shop owner).
const PUBLIC_FIELDS = ASSESSMENT_FIELDS.map((f) => ({
  key: f.key,
  page: f.page,
  type: f.type,
  required: !!f.required,
  prompt: f.prompt,
  help: f.help,
  labels: f.labels,
  min: f.min,
  max: f.max,
  minLength: f.minLength,
  options: f.options ? f.options.map((o) => ({ value: o.value, label: o.label })) : undefined,
  warningOnHardFail: f.warningOnHardFail,
}));

module.exports = {
  ASSESSMENT_FIELDS,
  FIELD_BY_KEY,
  WEIGHTED_KEYS,
  SAFETY_KEY,
  PUBLIC_FIELDS,
  validateSubmission,
  coerceBoolean,
};
