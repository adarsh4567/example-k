const router = require('express').Router();
const userAuth = require('../middleware/userAuth');
const c = require('../controllers/userProfileController');

// All customer profile routes require a user JWT (type:'user').
router.use(userAuth);

router.get('/', c.getProfile);
router.put('/', c.updateProfile); // { fullName }

module.exports = router;
