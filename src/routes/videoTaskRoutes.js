const router = require('express').Router();
const auth = require('../middleware/auth');
const c = require('../controllers/videoTaskController');
const { fail } = require('../utils/response');
const { resolveWorkerCategory } = require('../utils/workerCategory');
const { ASSESSMENT_ENABLED, ASSESSMENT_CATEGORY } = require('../config/assessmentConfig');

// Filter 1: Practical Video Task — worker-facing. All routes require a worker JWT.
router.use(auth);

/**
 * Electricians do not do the video task.
 *
 * Their hands-on skills are checked in person at a partner shop (Filter 3), so
 * recording skill videos as well would test the same thing twice — and the two
 * tasks in this flow are cleaning-specific ("mopping a floor", "cleaning a
 * bathroom sink"), so an electrician who reached them would be asked to
 * demonstrate the wrong trade entirely.
 *
 * The worker app already never opens these screens for an electrician; this gate
 * makes that true server-side too, so an older app build, a deep link or a manual
 * API call can't put an electrician into the wrong filter.
 *
 * NOTE: the video task was never part of the `onboardingStep` sequence
 * (phone → … → work_details → references → consent → submitted), so nothing here
 * affects step order or submission for any trade.
 */
function blockAssessmentCategory(req, res, next) {
  if (ASSESSMENT_ENABLED && resolveWorkerCategory(req.worker) === ASSESSMENT_CATEGORY) {
    return fail(
      res,
      'Electricians do not complete the video task. Your practical skills are assessed in person at a partner electrical shop instead.',
      403,
      { reason: 'video_task_not_applicable', finalGate: 'shop_assessment' }
    );
  }
  next();
}
router.use(blockAssessmentCategory);

// Instructions + limits for the Task Instructions screen.
router.get('/tasks', c.getTasks);

// Direct-to-S3 upload flow.
router.post('/presigned-url', c.getPresignedUrl);
router.post('/confirm-upload', c.confirmUpload);

// Resume support: which task videos are already uploaded/reviewed.
router.get('/status', c.getStatus);

module.exports = router;
