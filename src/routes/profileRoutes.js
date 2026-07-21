const router = require('express').Router();
const auth = require('../middleware/auth');
const upload = require('../middleware/upload');
const c = require('../controllers/profileController');
const specVideo = require('../controllers/specializationVideoController');

// All profile routes require a worker JWT. Unlike onboarding, these are editable
// at any status (per "worker can edit their expertise anytime").
router.use(auth);

router.get('/', c.getProfile);
router.get('/catalog', c.getCatalog);
router.put('/expertise', c.updateExpertise);
router.put('/', upload.single('profilePhoto'), c.updateProfile);

// Add a specialization via demo video (approved by a reviewer, not on upload).
router.post('/expertise/video/presigned-url', specVideo.getPresignedUrl);
router.post('/expertise/video/submit', specVideo.submit);

module.exports = router;
