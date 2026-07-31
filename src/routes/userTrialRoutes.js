const router = require('express').Router();
const userAuth = require('../middleware/userAuth');
const c = require('../controllers/userTrialController');

// Every route is scoped to the logged-in customer (type:'user' JWT).
router.use(userAuth);

// Literal paths BEFORE '/:id' — Express matches in order, so with them reversed
// "offer" and "active" would be swallowed as ids and 404.
router.get('/offer', c.getOffer);     // can I book? at what price? — call before showing the card
router.get('/active', c.activeTrial); // the one live booking, for app launch
router.post('/', c.createTrial);      // book → offers to the nearest trainee
router.get('/', c.listTrials);        // active + history

router.use('/:id', c.loadOwnedTrial);

router.get('/:id', c.getTrial);
router.post('/:id/cancel', c.cancelTrial);
router.post('/:id/retry', c.retryTrial);  // search again after nobody accepted

router.post('/:id/payment/initiate', c.initiatePayment); // { method }
router.post('/:id/payment/confirm', c.confirmPayment);   // { orderId } → credits the reward

// The form that onboards the worker.
router.get('/:id/feedback-form', c.getFeedbackForm);
router.post('/:id/feedback', c.submitFeedback);           // { answers: { q1..q10 } }

module.exports = router;
