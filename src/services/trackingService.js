const { distanceMeters, isValidCoord } = require('../utils/geo');
const {
  ARRIVED_RADIUS_M,
  ARRIVED_EXIT_RADIUS_M,
  ARRIVING_RADIUS_M,
  ARRIVING_ETA_MINUTES,
  AVG_SPEED_KMH,
  ROUTE_FACTOR,
  MIN_PING_INTERVAL_MS,
  MAX_ACCURACY_FOR_GEOFENCE_M,
  STALE_AFTER_SECONDS,
} = require('../config/trackingConfig');

/**
 * Live worker tracking: ingest a GPS ping, decide how close the worker is, and
 * hand the caller a verdict to persist and broadcast.
 *
 * Deliberately knows nothing about ServiceRequest, TrialJob, HTTP or sockets. It
 * takes a document that has `location` (GeoJSON Point) and `tracking` (see
 * models/workerTrackingSchema) and mutates the latter. That's what lets one
 * implementation serve both the on-demand flow and the trial flow, and it's what
 * makes the only part with real logic in it — computeArrivalStatus — testable
 * with no database, no network and no Express (see scripts/testArrivalStatus.js).
 *
 * The arrival decision is made HERE, on the server, for the same reason
 * `canRetry` and `payment.payable` are: it is a decision about the flow, not a
 * rendering detail. A client re-deriving it from raw coordinates would disagree
 * with the server the first time GPS misbehaved, and only on that one phone.
 */

/**
 * Straight-line distance ÷ assumed speed, inflated for the fact that roads bend.
 *
 * This is knowingly approximate. It exists because `null` is a worse answer than
 * "about 8 minutes" for a customer staring at a map, and because the accurate
 * alternative (a routing provider) costs money per call and should not be hit on
 * every 5-second ping while the worker is still 10 km out.
 *
 * Wiring in a real provider later means replacing this one function and setting
 * `etaSource:'directions'` — the throttling rule to apply then is "only call it
 * once the worker is inside ~2 km, and at most once every 20-30 s". Everything
 * downstream already reads `etaMinutes`/`etaSource` and needs no change.
 */
function estimateEtaMinutes(meters) {
  if (!Number.isFinite(meters) || meters < 0) return null;
  if (!AVG_SPEED_KMH) return null;
  const roadMeters = meters * ROUTE_FACTOR;
  const minutes = (roadMeters / 1000 / AVG_SPEED_KMH) * 60;
  return Math.max(1, Math.round(minutes));
}

/**
 * The whole geofence, as a pure function of (distance, eta, where we already were).
 *
 * @param {number} meters      straight-line distance from the job address
 * @param {number|null} eta    minutes, or null if unknown
 * @param {string} previous    the last arrivalStatus ('en_route' by default)
 * @returns {'en_route'|'arriving_soon'|'arrived'}
 */
function computeArrivalStatus(meters, eta, previous = 'en_route') {
  if (!Number.isFinite(meters)) return previous || 'en_route';

  // Hysteresis, and the reason this function has a `previous` argument at all:
  // once arrived, only a real pull-away demotes the worker. A phone sitting on a
  // doorstep drifts tens of metres between fixes, and without this band the
  // customer watches the badge flip arrived → en_route → arrived while the
  // worker is standing at their door. Demoting is also the more expensive
  // mistake — "they left again" is alarming in a way "still arrived" is not.
  if (previous === 'arrived' && meters < ARRIVED_EXIT_RADIUS_M) return 'arrived';

  if (meters <= ARRIVED_RADIUS_M) return 'arrived';
  if (meters <= ARRIVING_RADIUS_M || (eta != null && eta <= ARRIVING_ETA_MINUTES)) {
    return 'arriving_soon';
  }
  return 'en_route';
}

// The job address as [lat, lng], or null if the row somehow has no usable point.
function jobLatLng(job) {
  const coords = job.location && job.location.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const [lng, lat] = coords;
  return isValidCoord(Number(lat), Number(lng)) ? { lat: Number(lat), lng: Number(lng) } : null;
}

/**
 * Validate + normalise a ping body. Returns `{ ok:true, ping }` or a failure
 * carrying the HTTP code the controller should answer with, so validation lives
 * next to the rules it enforces rather than being restated in two controllers.
 */
function parsePing(body = {}) {
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (!isValidCoord(lat, lng)) {
    return { ok: false, code: 422, reason: 'Valid numeric lat and lng are required' };
  }
  // (0, 0) — "null island" — is within range but is never a real job site in
  // this product (it's the Gulf of Guinea). It's the single most common shape
  // of a broken GPS fix (an unset/zeroed value read as if it were valid), and
  // accepting it would silently teleport the marker there and compute a
  // meaningless multi-thousand-km distance against the real job address.
  if (lat === 0 && lng === 0) {
    return { ok: false, code: 422, reason: 'Coordinates (0, 0) look like an invalid GPS fix' };
  }

  // Heading is wrapped rather than rejected: 361° and -1° are both things a
  // compass API will hand you, and neither is worth failing a location ping over.
  let heading = null;
  if (body.heading !== undefined && body.heading !== null && Number.isFinite(Number(body.heading))) {
    heading = ((Number(body.heading) % 360) + 360) % 360;
  }

  const numberOrNull = (v) => (v !== undefined && v !== null && Number.isFinite(Number(v)) ? Number(v) : null);

  return {
    ok: true,
    ping: {
      lat,
      lng,
      heading,
      speedKmh: numberOrNull(body.speedKmh),
      accuracyMeters: numberOrNull(body.accuracy ?? body.accuracyMeters),
    },
  };
}

/**
 * Apply a ping to a job. MUTATES `job.tracking`; the caller saves and broadcasts.
 *
 * Split that way on purpose: persisting and pushing differ between the two flows
 * (different socket events, different payload builders), while everything worth
 * getting right — validation, throttling, the geofence — is identical. The
 * caller gets back exactly the two facts it needs to decide what to emit:
 * `changed` (did the badge move?) and `throttled` (was this ping dropped?).
 *
 * @returns {{ok:true, throttled:boolean, changed:boolean, previous:string, tracking:object}}
 *        | {{ok:false, code:number, reason:string}}
 */
function applyPing(job, body, { now = new Date() } = {}) {
  const parsed = parsePing(body);
  if (!parsed.ok) return parsed;

  const target = jobLatLng(job);
  if (!target) {
    return { ok: false, code: 409, reason: 'This job has no usable service location to track against' };
  }

  const { ping } = parsed;
  if (!job.tracking) job.tracking = {};
  const t = job.tracking;
  const previous = t.arrivalStatus || 'en_route';
  // Materialise the default rather than leaning on the schema's. Rows accepted
  // before this feature shipped have no tracking sub-document at all, and a ping
  // that doesn't move the badge would otherwise leave `arrivalStatus` undefined
  // on them — which serialises to a missing key and has clients rendering
  // "undefined" where the status should be.
  t.arrivalStatus = previous;

  // Throttle on the last ACCEPTED ping. Answered as a success by the caller —
  // see MIN_PING_INTERVAL_MS in trackingConfig for why this isn't a 429.
  if (t.updatedAt && now.getTime() - new Date(t.updatedAt).getTime() < MIN_PING_INTERVAL_MS) {
    return { ok: true, throttled: true, changed: false, previous, tracking: t };
  }

  const meters = distanceMeters(target.lat, target.lng, ping.lat, ping.lng);
  const eta = estimateEtaMinutes(meters);

  t.lat = ping.lat;
  t.lng = ping.lng;
  t.heading = ping.heading;
  t.speedKmh = ping.speedKmh;
  t.accuracyMeters = ping.accuracyMeters;
  t.updatedAt = now;
  t.pings = (t.pings || 0) + 1;
  t.distanceMeters = Math.round(meters);
  t.etaMinutes = eta;
  t.etaSource = eta == null ? null : 'estimate';

  // A fix this vague cannot honestly place the worker inside a 100 m geofence,
  // so it updates the dot but is not allowed to move the badge. The map showing
  // a slightly-wrong position is cosmetic; a wrong "Arrived" is not — the
  // customer walks to their door for nobody.
  const trustworthy =
    ping.accuracyMeters == null || ping.accuracyMeters <= MAX_ACCURACY_FOR_GEOFENCE_M;
  if (!trustworthy) {
    return { ok: true, throttled: false, changed: false, previous, tracking: t };
  }

  const next = computeArrivalStatus(meters, eta, previous);
  const changed = next !== previous;
  if (changed) {
    t.arrivalStatus = next;
    t.arrivalStatusChangedAt = now;
  }

  return { ok: true, throttled: false, changed, previous, tracking: t };
}

// Has this position gone stale? Drives `worker.locationStale` in the customer
// payloads, so the app can grey out a dot instead of presenting a confident
// position the worker left two minutes ago.
function isStale(tracking, now = new Date()) {
  if (!tracking || !tracking.updatedAt) return true;
  return now.getTime() - new Date(tracking.updatedAt).getTime() > STALE_AFTER_SECONDS * 1000;
}

/**
 * The customer-facing shape of a job's tracking state. One builder for both
 * flows — utils/requestPayload and utils/trialPayload both splice this into
 * their `worker` block, so the app's map component sees identical fields
 * whichever kind of booking it is rendering.
 *
 * Returns nulls rather than an absent object when no ping has landed yet: an
 * undefined field is what makes a client render "arriving in undefined min".
 */
function trackingView(tracking, now = new Date()) {
  const t = tracking || {};
  const hasFix = Number.isFinite(t.lat) && Number.isFinite(t.lng);
  return {
    // GeoJSON Point, matching the shape `worker.location` already had, so an app
    // reading `coordinates[0]`/`[1]` today keeps working against the live value.
    location: hasFix ? { type: 'Point', coordinates: [t.lng, t.lat] } : null,
    locationUpdatedAt: t.updatedAt || null,
    locationStale: hasFix ? isStale(t, now) : true,
    heading: t.heading ?? null,
    speedKmh: t.speedKmh ?? null,
    distanceMeters: t.distanceMeters ?? null,
    // Kept alongside distanceMeters because every existing screen renders km.
    liveDistanceKm: Number.isFinite(t.distanceMeters) ? Math.round(t.distanceMeters / 10) / 100 : null,
    etaMinutes: t.etaMinutes ?? null,
    etaSource: t.etaSource || null,
    arrivalStatus: t.arrivalStatus || 'en_route',
    arrivalStatusChangedAt: t.arrivalStatusChangedAt || null,
  };
}

// Wipe tracking back to its initial state. Called when a worker is bound to a
// job, so a re-dispatched or retried row can never show the previous worker's
// last known position as if it were the new one's.
function resetTracking(job) {
  job.tracking = {
    lat: null,
    lng: null,
    heading: null,
    speedKmh: null,
    accuracyMeters: null,
    updatedAt: null,
    pings: 0,
    distanceMeters: null,
    etaMinutes: null,
    etaSource: null,
    arrivalStatus: 'en_route',
    arrivalStatusChangedAt: null,
  };
}

module.exports = {
  computeArrivalStatus,
  estimateEtaMinutes,
  parsePing,
  applyPing,
  isStale,
  trackingView,
  resetTracking,
  jobLatLng,
};
