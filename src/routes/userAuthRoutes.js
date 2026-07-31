const router = require('express').Router();
const userAuth = require('../middleware/userAuth');
const { sendOtp, resendOtp, verifyOtp, logout } = require('../controllers/userAuthController');

// Customer ("user") login. Public — the OTP IS the credential.
// Mirrors /api/auth/* (the worker flow) against the User collection.
router.post('/send-otp', sendOtp);
router.post('/resend-otp', resendOtp);
router.post('/verify-otp', verifyOtp); // { phone, otp, name?, referralCode? }

// "Sign out everywhere" — the only route here that needs a token, because it
// revokes the account's existing ones. Ordinary sign-out stays local to the app
// and calls nothing; see the controller.
router.post('/logout', userAuth, logout);

module.exports = router;
