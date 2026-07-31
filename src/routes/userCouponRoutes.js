const router = require('express').Router();
const userAuth = require('../middleware/userAuth');
const c = require('../controllers/userOffersController');

// Offers the customer can use. Authenticated rather than public (unlike the
// service catalog) because the list is per-account: "first booking only" offers
// disappear once you've booked.
router.use(userAuth);

router.get('/', c.listCoupons);
router.post('/validate', c.validateCoupon); // { code, subtotal }

module.exports = router;
