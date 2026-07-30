const router = require('express').Router();
const userAuth = require('../middleware/userAuth');
const c = require('../controllers/userServiceRequestController');

// Every route here is scoped to the logged-in customer (type:'user' JWT).
router.use(userAuth);

router.post('/', c.createRequest);        // raise a request → starts the 1-min search
router.get('/', c.listRequests);          // my requests: active + history
router.get('/active', c.activeRequest);   // the one live request, for app launch

// `/active` is declared BEFORE the `/:id` routes on purpose — Express matches in
// order, so with them reversed "active" would be swallowed as an id and 404.
router.use('/:id', c.loadOwnedRequest);

router.get('/:id', c.getRequest);
router.post('/:id/cancel', c.cancelRequest);
router.post('/:id/retry', c.retryRequest); // search again after the timer expired

router.post('/:id/payment/initiate', c.initiatePayment); // { method }
router.post('/:id/payment/confirm', c.confirmPayment);   // { orderId, gatewayReference? }

module.exports = router;
