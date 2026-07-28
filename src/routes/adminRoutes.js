const router = require('express').Router();
const adminAuth = require('../middleware/adminAuth');
const c = require('../controllers/adminController');
const video = require('../controllers/videoReviewController');
const specReview = require('../controllers/specializationReviewController');
const trial = require('../controllers/trialAdminController');
const assessment = require('../controllers/assessmentAdminController');

// Public
router.post('/login', c.login);

// Protected — require admin JWT
router.use(adminAuth);
router.get('/workers', c.listWorkers);
router.get('/workers/:id', c.getWorker);
router.post('/workers/:id/move-to-review', c.moveToReview);
router.post('/workers/:id/approve', c.approveWorker);
router.post('/workers/:id/reject', c.rejectWorker);
router.post('/workers/:id/request-info', c.requestInfo);

// Filter 1: Practical Video Task review
router.get('/video-review/queue', video.queue);
router.get('/video-review/:workerId', video.getWorkerVideos);
router.post('/video-review/:workerId/decision', video.decide);

// "Add a specialization" video review
router.get('/specialization-submissions', specReview.list);
router.get('/specialization-submissions/:id/video', specReview.getVideo);
router.post('/specialization-submissions/:id/approve', specReview.approve);
router.post('/specialization-submissions/:id/reject', specReview.reject);

// Filter 2: Trial Job management (assign / queue / review / decide)
router.get('/trial-queue', trial.trialQueue);
// NOTE: keep this literal route above '/trial/:id' so it isn't captured as :id.
router.get('/trial/nearby-workers', trial.nearbyTrialWorkers);
router.post('/trial/assign', trial.assignTrial);
router.get('/trial/:id', trial.getTrial);
router.post('/trial/:id/decision', trial.decideTrial);

// ── Filter 3: Electrical Shop Assessment ─────────────────────────────────────
// Shop partner management (PART 2 / API group 1).
router.post('/shop-partners', assessment.createPartner);
router.get('/shop-partners', assessment.listPartners);
router.get('/shop-partners/:partnerId', assessment.getPartner);
router.patch('/shop-partners/:partnerId', assessment.updatePartner);
router.patch('/shop-partners/:partnerId/status', assessment.updatePartnerStatus);
router.post('/shop-partners/:partnerId/recalculate-quality', assessment.recalculateQuality);
// Slot calendar.
router.post('/shop-partners/:partnerId/slots', assessment.createSlots);
router.get('/shop-partners/:partnerId/slots', assessment.listSlots);
router.delete('/shop-partners/:partnerId/slots/:slotId', assessment.deleteSlot);

// Assessment review + decisions (API group 4).
// NOTE: keep these literal routes above '/assessments/:assessmentId' so they
// aren't captured as an id (same reason as '/trial/nearby-workers' above).
router.get('/assessments/pending-review', assessment.pendingReview);
router.get('/assessments/payments/pending', assessment.pendingPayments);
router.get('/assessments/feedback-form', assessment.feedbackForm);
router.post('/assessments/run-jobs', assessment.runJobs);
router.get('/assessments', assessment.listAssessments);
router.get('/assessments/:assessmentId', assessment.getAssessment);
// Ops standing in for the shop owner: override the geofenced check-in, then enter
// the owner's feedback. Both mirror the partner web form exactly.
router.post('/assessments/:assessmentId/mark-arrived', assessment.markArrived);
router.post('/assessments/:assessmentId/feedback', assessment.submitFeedbackAsAdmin);
router.post('/assessments/:assessmentId/decide', assessment.decideAssessment);
router.post('/assessments/:assessmentId/payments/:kind/mark-paid', assessment.markPaymentPaid);

module.exports = router;
