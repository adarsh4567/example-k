const router = require('express').Router();
const userAuth = require('../middleware/userAuth');
const c = require('../controllers/userWalletController');

// The customer's reward wallet. It started as trial cashback only and lived with
// the trial controller for that reason; referral rewards fund it too now, so it
// has its own controller and service.
router.use(userAuth);

router.get('/', c.getWallet);

module.exports = router;
