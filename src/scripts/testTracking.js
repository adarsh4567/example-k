/**
 * Standalone unit tests for the live-tracking geofence — the one piece of this
 * feature with real logic in it, and the place threshold/hysteresis bugs
 * actually live. No test framework is configured, so this uses node's built-in
 * assert and is run with:  node src/scripts/testTracking.js
 * (or `npm run test:tracking`). Exits non-zero on any failure.
 *
 * Everything here is pure — no database, no network, no Express — which is the
 * whole reason computeArrivalStatus/applyPing were split out of the HTTP
 * handlers. The integration concerns (wrong worker → 403, wrong status → 409)
 * are exercised against a running server by scripts/worker-client.js instead.
 */

const assert = require('assert');
const {
  computeArrivalStatus,
  estimateEtaMinutes,
  applyPing,
  isStale,
  trackingView,
} = require('../services/trackingService');
const {
  ARRIVED_RADIUS_M,
  ARRIVED_EXIT_RADIUS_M,
  ARRIVING_RADIUS_M,
  MIN_PING_INTERVAL_MS,
  MAX_ACCURACY_FOR_GEOFENCE_M,
  STALE_AFTER_SECONDS,
} = require('../config/trackingConfig');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}\n      ${err.message}`);
  }
}

// ── computeArrivalStatus: the thresholds ────────────────────────
console.log('\ncomputeArrivalStatus — thresholds');

const cases = [
  ['far away → en_route', 8000, null, 'en_route', 'en_route'],
  ['just outside the arriving ring → en_route', ARRIVING_RADIUS_M + 1, null, 'en_route', 'en_route'],
  ['on the arriving ring → arriving_soon', ARRIVING_RADIUS_M, null, 'en_route', 'arriving_soon'],
  ['inside the arriving ring → arriving_soon', 800, null, 'en_route', 'arriving_soon'],
  ['just outside the arrived ring → arriving_soon', ARRIVED_RADIUS_M + 1, null, 'arriving_soon', 'arriving_soon'],
  ['on the arrived ring → arrived', ARRIVED_RADIUS_M, null, 'arriving_soon', 'arrived'],
  ['at the door → arrived', 5, null, 'arriving_soon', 'arrived'],
  // A short ETA promotes to arriving_soon even from far out — the customer cares
  // about time, not metres, and 4 minutes down a clear road is "nearly here".
  ['far but low ETA → arriving_soon', 6000, 4, 'en_route', 'arriving_soon'],
  ['far with a long ETA → en_route', 6000, 22, 'en_route', 'en_route'],
];

cases.forEach(([name, meters, eta, previous, expected]) => {
  check(name, () => assert.strictEqual(computeArrivalStatus(meters, eta, previous), expected));
});

// ── computeArrivalStatus: hysteresis ────────────────────────────
// This is the reason the function takes `previous` at all. A phone sitting on a
// doorstep drifts tens of metres between fixes; without the wider exit band the
// badge flaps arrived → en_route → arrived while nobody has moved.
console.log('\ncomputeArrivalStatus — hysteresis once arrived');

check('GPS jitter just outside the arrived ring stays arrived', () =>
  assert.strictEqual(computeArrivalStatus(ARRIVED_RADIUS_M + 40, null, 'arrived'), 'arrived')
);
check('drift up to just under the exit band stays arrived', () =>
  assert.strictEqual(computeArrivalStatus(ARRIVED_EXIT_RADIUS_M - 1, null, 'arrived'), 'arrived')
);
check('a real walk away past the exit band demotes', () =>
  assert.strictEqual(computeArrivalStatus(ARRIVED_EXIT_RADIUS_M + 1, null, 'arrived'), 'arriving_soon')
);
check('driving right off demotes all the way to en_route', () =>
  assert.strictEqual(computeArrivalStatus(9000, 30, 'arrived'), 'en_route')
);
check('the wide band does NOT apply before arriving', () =>
  // Same distance, different history: only a previously-arrived worker gets the
  // benefit of the doubt. Otherwise a worker who has never been close would be
  // called "arrived" 200 m out.
  assert.strictEqual(computeArrivalStatus(ARRIVED_EXIT_RADIUS_M - 1, null, 'arriving_soon'), 'arriving_soon')
);

check('a non-finite distance never changes the verdict', () => {
  assert.strictEqual(computeArrivalStatus(NaN, null, 'arrived'), 'arrived');
  assert.strictEqual(computeArrivalStatus(undefined, null, 'arriving_soon'), 'arriving_soon');
});

// ── estimateEtaMinutes ──────────────────────────────────────────
console.log('\nestimateEtaMinutes');

check('grows with distance', () =>
  assert.ok(estimateEtaMinutes(10000) > estimateEtaMinutes(1000))
);
check('never returns 0 for a real distance (a customer reads "0 min" as "here")', () =>
  assert.ok(estimateEtaMinutes(30) >= 1)
);
check('rejects nonsense', () => {
  assert.strictEqual(estimateEtaMinutes(NaN), null);
  assert.strictEqual(estimateEtaMinutes(-5), null);
});

// ── applyPing: validation, throttling, accuracy gating ──────────
console.log('\napplyPing');

// A stand-in job: applyPing only needs `location` (GeoJSON) and `tracking`.
// Reference point is central Bengaluru; the offsets below are ~real metres.
const SITE = { lat: 12.9716, lng: 77.5946 };
const makeJob = (tracking = {}) => ({
  location: { type: 'Point', coordinates: [SITE.lng, SITE.lat] },
  tracking,
});
// ~111,320 m per degree of latitude, so this converts metres → a latitude offset.
const northOf = (meters) => SITE.lat + meters / 111320;

check('rejects a missing/invalid coordinate with 422', () => {
  const r = applyPing(makeJob(), { lat: 'abc', lng: 77.5 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 422);
});

check('rejects (0,0) — null island — even though it is in-range', () => {
  const r = applyPing(makeJob(), { lat: 0, lng: 0 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 422);
});

check('rejects a job with no service location with 409', () => {
  const r = applyPing({ location: null, tracking: {} }, { lat: SITE.lat, lng: SITE.lng });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 409);
});

check('a far first ping lands as en_route and records distance + eta', () => {
  const job = makeJob();
  const r = applyPing(job, { lat: northOf(9000), lng: SITE.lng });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.throttled, false);
  assert.strictEqual(job.tracking.arrivalStatus, 'en_route');
  assert.ok(Math.abs(job.tracking.distanceMeters - 9000) < 100, `got ${job.tracking.distanceMeters} m`);
  assert.ok(job.tracking.etaMinutes > 0);
  assert.strictEqual(job.tracking.etaSource, 'estimate');
  assert.strictEqual(job.tracking.pings, 1);
});

check('arriving at the door flips the badge and reports changed:true', () => {
  const job = makeJob();
  applyPing(job, { lat: northOf(9000), lng: SITE.lng });
  // Second ping needs to clear the throttle floor — hand it a later clock.
  const later = new Date(Date.now() + MIN_PING_INTERVAL_MS + 1000);
  const r = applyPing(job, { lat: northOf(20), lng: SITE.lng }, { now: later });
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.previous, 'en_route');
  assert.strictEqual(job.tracking.arrivalStatus, 'arrived');
  assert.ok(job.tracking.arrivalStatusChangedAt);
});

check('a ping inside the throttle floor is dropped, not errored', () => {
  const job = makeJob();
  applyPing(job, { lat: northOf(5000), lng: SITE.lng });
  const before = job.tracking.distanceMeters;
  const r = applyPing(job, { lat: northOf(20), lng: SITE.lng }); // immediately after
  assert.strictEqual(r.ok, true, 'a chatty client is not a client error');
  assert.strictEqual(r.throttled, true);
  assert.strictEqual(r.changed, false);
  assert.strictEqual(job.tracking.distanceMeters, before, 'throttled ping must not write');
  assert.strictEqual(job.tracking.pings, 1);
});

check('a low-accuracy fix moves the dot but not the badge', () => {
  const job = makeJob();
  const r = applyPing(job, {
    lat: northOf(20),
    lng: SITE.lng,
    accuracy: MAX_ACCURACY_FOR_GEOFENCE_M + 200,
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.changed, false, 'a ±350 m fix cannot honestly claim a 100 m geofence');
  assert.strictEqual(job.tracking.arrivalStatus, 'en_route');
  assert.ok(Number.isFinite(job.tracking.lat), 'the position itself is still recorded');
});

check('heading is wrapped into 0-360 rather than rejected', () => {
  const job = makeJob();
  applyPing(job, { lat: northOf(3000), lng: SITE.lng, heading: 450 });
  assert.strictEqual(job.tracking.heading, 90);
  const later = new Date(Date.now() + MIN_PING_INTERVAL_MS + 1000);
  applyPing(job, { lat: northOf(2900), lng: SITE.lng, heading: -90 }, { now: later });
  assert.strictEqual(job.tracking.heading, 270);
});

// ── staleness + the customer-facing shape ───────────────────────
console.log('\ntrackingView / isStale');

check('a job with no ping yet is stale and renders all-null, never undefined', () => {
  const v = trackingView({});
  assert.strictEqual(v.location, null);
  assert.strictEqual(v.locationStale, true);
  assert.strictEqual(v.etaMinutes, null);
  assert.strictEqual(v.arrivalStatus, 'en_route');
  Object.entries(v).forEach(([k, val]) =>
    assert.notStrictEqual(val, undefined, `${k} must be null, not undefined`)
  );
});

check('a fresh ping is not stale', () => {
  const job = makeJob();
  applyPing(job, { lat: northOf(500), lng: SITE.lng });
  assert.strictEqual(isStale(job.tracking), false);
  assert.strictEqual(trackingView(job.tracking).locationStale, false);
});

check('an old ping goes stale', () => {
  const job = makeJob();
  applyPing(job, { lat: northOf(500), lng: SITE.lng });
  const wayLater = new Date(Date.now() + (STALE_AFTER_SECONDS + 10) * 1000);
  assert.strictEqual(isStale(job.tracking, wayLater), true);
  assert.strictEqual(trackingView(job.tracking, wayLater).locationStale, true);
});

check('location is emitted as GeoJSON [lng, lat], matching worker.location', () => {
  const job = makeJob();
  applyPing(job, { lat: northOf(500), lng: SITE.lng });
  const v = trackingView(job.tracking);
  assert.strictEqual(v.location.type, 'Point');
  assert.ok(Math.abs(v.location.coordinates[0] - SITE.lng) < 0.0001, 'coordinates[0] must be lng');
  assert.ok(Math.abs(v.location.coordinates[1] - northOf(500)) < 0.0001, 'coordinates[1] must be lat');
});

console.log(
  failures === 0
    ? '\n✅ tracking: all checks passed\n'
    : `\n❌ tracking: ${failures} check(s) failed\n`
);
process.exit(failures === 0 ? 0 : 1);
