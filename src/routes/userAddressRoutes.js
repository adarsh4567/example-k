const router = require('express').Router();
const userAuth = require('../middleware/userAuth');
const c = require('../controllers/userAddressController');

// The customer's saved addresses. The app still keeps its local copy — this is
// the backup that survives a reinstall, not a replacement for it.
router.use(userAuth);

router.get('/', c.listAddresses);
router.post('/', c.addAddress);              // { label?, locality?, city?, line?, lat, lng }
router.delete('/:id', c.removeAddress);
router.put('/:id/select', c.selectAddress);

module.exports = router;
