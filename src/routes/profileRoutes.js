const router = require('express').Router();
const auth = require('../middleware/auth');
const upload = require('../middleware/upload');
const c = require('../controllers/profileController');

// All profile routes require a worker JWT. Unlike onboarding, these are editable
// at any status (per "worker can edit their expertise anytime").
router.use(auth);

router.get('/', c.getProfile);
router.get('/catalog', c.getCatalog);
router.put('/expertise', c.updateExpertise);
router.put('/', upload.single('profilePhoto'), c.updateProfile);

module.exports = router;
