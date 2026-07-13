const router = require('express').Router();
const { cities, suggest } = require('../controllers/placesController');

// Public helpers for Screen 3.
router.get('/cities', cities);
router.get('/suggest', suggest);

module.exports = router;
