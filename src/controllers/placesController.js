const { listCities, suggestLocalities } = require('../services/placesService');
const { ok, fail } = require('../utils/response');

// GET /api/places/cities
async function cities(req, res, next) {
  try {
    return ok(res, { cities: listCities() }, 'Operating cities');
  } catch (err) {
    next(err);
  }
}

// GET /api/places/suggest?city=Bengaluru&q=kor
async function suggest(req, res, next) {
  try {
    const { city, q } = req.query;
    if (!city) return fail(res, 'city query parameter is required', 422);
    const suggestions = await suggestLocalities(city, q || '');
    return ok(res, { suggestions }, 'Locality suggestions');
  } catch (err) {
    next(err);
  }
}

module.exports = { cities, suggest };
