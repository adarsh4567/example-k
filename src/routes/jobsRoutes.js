const router = require('express').Router();
const auth = require('../middleware/auth');
const c = require('../controllers/jobsController');

// Worker-facing job endpoints. All require a worker JWT.
router.use(auth);

router.put('/availability', c.updateAvailability); // go online/offline + location heartbeat
router.get('/available', c.availableJobs);          // pending offers open to me
router.get('/mine', c.myJobs);                       // my active + past jobs
router.post('/:id/accept', c.acceptJob);
router.post('/:id/decline', c.declineJob);

// The job itself, in order: accept → (travel, pinging location) → start → complete → rate.
router.post('/:id/location', c.updateJobLocation); // live position while en route
router.post('/:id/start', c.startJob);             // arrived on site → work begins
router.post('/:id/complete', c.completeJob); // marks work done → pending_rating
router.post('/:id/rate', c.rateJob);          // submits 1-5 rating → completed

module.exports = router;
