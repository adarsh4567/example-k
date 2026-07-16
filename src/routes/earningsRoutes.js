const router = require('express').Router();
const auth = require('../middleware/auth');
const c = require('../controllers/earningsController');

// Worker-facing earnings endpoints. All require a worker JWT.
router.use(auth);

router.get('/summary', c.getSummary);

module.exports = router;
