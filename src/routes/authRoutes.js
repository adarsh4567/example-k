const router = require('express').Router();
const { sendOtp, resendOtp, verifyOtp } = require('../controllers/authController');

router.post('/send-otp', sendOtp);
router.post('/resend-otp', resendOtp);
router.post('/verify-otp', verifyOtp);

module.exports = router;
