// Great-circle distance helpers. Hand-rolled to avoid a dependency for ~10 lines
// of trigonometry (the repo already does its geo *matching* in Mongo via
// $geoNear; this is for the one-off "is the worker at the shop?" check).

const EARTH_RADIUS_M = 6371000;

const toRad = (deg) => (deg * Math.PI) / 180;

// Haversine distance between two lat/lng points, in metres.
function distanceMeters(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Same, in kilometres rounded to 2dp (the shape the app renders).
function distanceKm(lat1, lng1, lat2, lng2) {
  return Math.round((distanceMeters(lat1, lng1, lat2, lng2) / 1000) * 100) / 100;
}

// Is this a usable WGS84 coordinate pair?
function isValidCoord(lat, lng) {
  return (
    typeof lat === 'number' && typeof lng === 'number' &&
    Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
  );
}

module.exports = { distanceMeters, distanceKm, isValidCoord, EARTH_RADIUS_M };
