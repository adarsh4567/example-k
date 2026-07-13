const router = require('express').Router();
const adminAuth = require('../middleware/adminAuth');
const c = require('../controllers/adminController');

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

module.exports = router;
