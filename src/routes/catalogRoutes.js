const router = require('express').Router();
const { SERVICE_CATALOG } = require('../services/serviceCatalog');
const { CATEGORY_BASE_PRICE, CURRENCY } = require('../services/pricingService');
const { ok } = require('../utils/response');

/**
 * GET /api/services — the bookable service catalog with prices.
 *
 * The customer app's category picker needs exactly this, and it must come from
 * the server: the `category`/`subcategory` keys are validated on request creation
 * and the price shown before booking has to be the price the request is actually
 * created with. A hardcoded client-side copy of this list is how you end up with
 * a "book" button that 422s, or a quoted price that doesn't match the bill.
 *
 * Public — it's a menu, and the app needs it on the pre-login browse screen.
 * `price` is the flat rate-card total the customer pays for that category (dummy
 * pricing; see pricingService). Subcategories don't change the price yet.
 */
router.get('/', (req, res) => {
  const services = SERVICE_CATALOG.map((cat) => ({
    key: cat.key,
    name: cat.name,
    color: cat.color,
    price: CATEGORY_BASE_PRICE[cat.key] ?? null,
    currency: CURRENCY,
    subcategories: cat.subcategories.map((s) => ({ key: s.key, name: s.name })),
  }));
  return ok(res, { services, currency: CURRENCY }, 'Service catalog');
});

module.exports = router;
