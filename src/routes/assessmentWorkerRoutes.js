const router = require('express').Router();
const auth = require('../middleware/auth');
const c = require('../controllers/assessmentWorkerController');

// Filter 3: Electrical Shop Assessment — worker-facing. All routes require a
// worker JWT. Paths match PART 3 of the implementation guide so the worker app
// can be built straight from it.
router.use(auth);

router.get('/intro', c.getIntro);                    // Screen 1 copy + eligibility
router.get('/available-slots', c.availableSlots);    // Screen 2 slot picker
router.post('/book-slot', c.bookSlot);               // Screen 2 → 3
router.post('/cancel-booking', c.cancelBooking);
router.post('/check-in', c.checkIn);                 // Screen 4
router.get('/certificate', c.getCertificate);        // Screen 6 (approved)
// Screen 6 "Continue" — hands the worker off to the main app. Best-effort on the
// client, so it is idempotent and never errors on a repeat call.
router.post('/acknowledge-decision', c.acknowledgeDecision);

// Status poll. The guide passes workerId in the path; it is validated against the
// JWT rather than trusted. The bare /status form is the one to prefer.
router.get('/status', c.getStatus);
router.get('/status/:workerId', c.getStatus);

module.exports = router;
