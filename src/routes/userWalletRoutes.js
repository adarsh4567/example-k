const router = require('express').Router();
const userAuth = require('../middleware/userAuth');
const c = require('../controllers/userTrialController');

// The customer's reward wallet. Its only funding source today is trial cashback,
// which is why the handler lives with the trial controller — if a second reward
// reason appears, move it to its own controller then, not speculatively.
router.use(userAuth);

router.get('/', c.getWallet);

module.exports = router;
