const router = require('express').Router();
const c = require('../controllers/trialFeedbackController');

// Public — no auth. Access is gated by the signed one-time token in the path
// (see services/trialTokenService). Stands in for the not-yet-built customer app.
router.get('/:token', c.getForm);
router.post('/:token', c.submitFeedback);

module.exports = router;
