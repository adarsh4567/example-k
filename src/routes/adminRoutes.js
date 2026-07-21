const router = require('express').Router();
const adminAuth = require('../middleware/adminAuth');
const c = require('../controllers/adminController');
const video = require('../controllers/videoReviewController');

// Public
router.post('/login', c.login);

// Protected — require admin JWT
router.use(adminAuth);
router.get('/workers', c.listWorkers);
router.get('/workers/:id', c.getWorker);
router.post('/workers/:id/move-to-review', c.moveToReview);
router.post('/workers/:id/approve', c.approveWorker);
router.post('/workers/:id/reject', c.rejectWorker);
router.post('/workers/:id/request-info', c.requestInfo);

// Filter 1: Practical Video Task review
router.get('/video-review/queue', video.queue);
router.get('/video-review/:workerId', video.getWorkerVideos);
router.post('/video-review/:workerId/decision', video.decide);

module.exports = router;
