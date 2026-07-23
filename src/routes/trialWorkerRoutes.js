const router = require('express').Router();
const auth = require('../middleware/auth');
const c = require('../controllers/trialWorkerController');

// Filter 2: Trial Job — worker-facing. All routes require a worker JWT.
router.use(auth);

router.get('/status', c.getStatus);          // fallback poll for waiting/submitted screens
router.post('/:id/accept', c.acceptTrial);
router.post('/:id/decline', c.declineTrial);
router.post('/:id/start', c.startTrial);
router.post('/:id/complete', c.completeTrial); // checkout → awaiting customer feedback

module.exports = router;
