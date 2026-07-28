const router = require('express').Router();
const c = require('../controllers/assessmentPartnerController');

// Filter 3: shop owner feedback — PUBLIC, no auth middleware. Access is gated by
// the signed token in the link that was SMS'd / WhatsApp'd to the owner at
// booking time (see services/assessmentTokenService). The shop owner has no
// account, so there is nothing to log in to.
//
// Mounted at /api/partner/assessment to match PART 3/PART 5 of the guide, which
// the partner web form is built against. Despite the name, these routes are
// unauthenticated by design — the token IS the credential.

// Render context for the form (worker name, slot, field definitions).
router.get('/form/:token', c.getForm);

// Submit — token in the body per the guide, or in the path for convenience.
router.post('/submit-feedback', c.submitFeedback);
router.post('/form/:token', c.submitFeedback);

// The worker never turned up.
router.post('/mark-no-show', c.markNoShow);
router.post('/form/:token/no-show', c.markNoShow);

module.exports = router;
