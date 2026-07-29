const router = require('express').Router();
const { sendOtp, resendOtp, verifyOtp } = require('../controllers/userAuthController');

// Customer ("user") login. Public — the OTP IS the credential.
// Mirrors /api/auth/* (the worker flow) against the User collection.
router.post('/send-otp', sendOtp);
router.post('/resend-otp', resendOtp);
router.post('/verify-otp', verifyOtp);

module.exports = router;
