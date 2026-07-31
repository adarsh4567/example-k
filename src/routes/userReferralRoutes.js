const router = require('express').Router();
const userAuth = require('../middleware/userAuth');
const c = require('../controllers/userOffersController');

// The customer's own referral code and the programme's terms.
router.use(userAuth);

router.get('/', c.getReferral);

module.exports = router;
