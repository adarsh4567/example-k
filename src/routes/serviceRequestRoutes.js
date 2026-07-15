const router = require('express').Router();
const c = require('../controllers/serviceRequestController');

// Customer-facing. No auth for now — the customer app isn't built yet, so these
// are fired directly. Add customer auth later without changing the dispatch flow.
router.post('/', c.createRequest);
router.get('/:id', c.getRequest);
router.post('/:id/cancel', c.cancelRequest);

module.exports = router;
