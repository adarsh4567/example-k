const router = require('express').Router();
const auth = require('../middleware/auth');
const upload = require('../middleware/upload');
const c = require('../controllers/onboardingController');

// All onboarding routes require a verified-worker JWT.
router.use(auth);

// Screen 2 — personal details (live selfie as `profilePhoto`)
router.put('/personal', upload.single('profilePhoto'), c.updatePersonal);

// Screen 3 — location
router.put('/location', c.updateLocation);

// Screen 4 — Aadhaar OTP verification
router.post('/aadhaar/request-otp', c.aadhaarRequestOtp);
router.post('/aadhaar/verify', c.aadhaarVerify);

// Screen 5 — face match (live selfie as `selfie`)
router.post('/face-match', upload.single('selfie'), c.faceMatch);

// Screen 6 — work details & skills
router.put('/work-details', c.updateWorkDetails);

// Screen 7 — references
router.put('/references', c.updateReferences);

// Screen 8 — Aadhaar e-sign (demo mock, alternative to uploading a signature image)
router.post('/consent/esign/request-otp', c.esignRequestOtp);
router.post('/consent/esign/verify', c.esignVerifyOtp);

// Screen 8 — background check consent (signature image as `signature`, or a prior e-sign verify)
router.post('/consent', upload.single('signature'), c.submitConsent);

// Screen 9 — submit + status tracker
router.post('/submit', c.submitApplication);
router.get('/status', c.getStatus);

module.exports = router;
