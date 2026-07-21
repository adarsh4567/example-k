const router = require('express').Router();
const auth = require('../middleware/auth');
const c = require('../controllers/videoTaskController');

// Filter 1: Practical Video Task — worker-facing. All routes require a worker JWT.
router.use(auth);

// Instructions + limits for the Task Instructions screen.
router.get('/tasks', c.getTasks);

// Direct-to-S3 upload flow.
router.post('/presigned-url', c.getPresignedUrl);
router.post('/confirm-upload', c.confirmUpload);

// Resume support: which task videos are already uploaded/reviewed.
router.get('/status', c.getStatus);

module.exports = router;
