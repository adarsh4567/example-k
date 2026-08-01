/**
 * Live worker-tracking tuning knobs, in one place.
 *
 * Lifted out of trackingService for the same reason dispatchConfig exists: the
 * customer-facing serializers (utils/requestPayload, utils/trialPayload) need
 * some of these numbers — the staleness cut-off to decide whether a marker is
 * trustworthy — and importing the service from a payload builder would create a
 * require cycle (the service already reaches the payload builders to push live
 * updates).
 *
 * Every threshold is env-overridable on purpose. "Arrived" for a dense apartment
 * complex and "arrived" for a rural plot want different radii, and the only
 * honest way to find the right numbers is to run the flow and move them.
 */

// ── Geofence thresholds ─────────────────────────────────────────
// Inside this radius of the job address the worker counts as ARRIVED.
const ARRIVED_RADIUS_M = Number(process.env.TRACKING_ARRIVED_RADIUS_M || 100);

// Hysteresis: once arrived, the worker must get THIS far away before we admit
// they're en route again. Deliberately much larger than ARRIVED_RADIUS_M — a
// phone standing still on a doorstep routinely reports positions 30-80 m apart,
// and without the gap the badge flaps arrived → en_route → arrived on noise.
const ARRIVED_EXIT_RADIUS_M = Number(process.env.TRACKING_ARRIVED_EXIT_RADIUS_M || 250);

// Inside this radius (or under ARRIVING_ETA_MINUTES) the status is ARRIVING_SOON.
const ARRIVING_RADIUS_M = Number(process.env.TRACKING_ARRIVING_RADIUS_M || 1500);
const ARRIVING_ETA_MINUTES = Number(process.env.TRACKING_ARRIVING_ETA_MINUTES || 5);

// ── ETA estimation ──────────────────────────────────────────────
// Until a routing provider is wired in (see trackingService.estimateEta), the
// ETA is straight-line distance ÷ an assumed speed, inflated by ROUTE_FACTOR to
// account for roads not being straight. Crude, but strictly more useful to the
// customer than no number at all, and it is labelled `etaSource:'estimate'` in
// the payload so the app can word it as "~12 min" rather than "12 min".
const AVG_SPEED_KMH = Number(process.env.TRACKING_AVG_SPEED_KMH || 18);
const ROUTE_FACTOR = Number(process.env.TRACKING_ROUTE_FACTOR || 1.3);

// ── Ping hygiene ────────────────────────────────────────────────
// Server-side floor between two accepted pings for one job. The worker app
// throttles too (see the integration guide); this is defence in depth against a
// buggy build hammering the endpoint, not the primary throttle. A ping that
// arrives early is answered 200 with `throttled:true` rather than an error — a
// chatty client is not a client error, and making it look like one would push
// worker apps into retry loops.
const MIN_PING_INTERVAL_MS = Number(process.env.TRACKING_MIN_PING_INTERVAL_MS || 3000);

// A ping worse than this accuracy is recorded but NOT allowed to move the
// arrival status. A 500 m-accurate fix "inside" a 100 m geofence means nothing.
const MAX_ACCURACY_FOR_GEOFENCE_M = Number(process.env.TRACKING_MAX_ACCURACY_M || 150);

// How long a position stays believable. Past this the customer payload carries
// `locationStale:true` so the app can grey the marker out instead of showing a
// confident dot where the worker was two minutes ago.
const STALE_AFTER_SECONDS = Number(process.env.TRACKING_STALE_AFTER_SECONDS || 60);

// ── Rollout switch ──────────────────────────────────────────────
// When true, a job must be STARTED (worker tapped "Start job" on arrival) before
// it can be marked complete. This is the new two-step worker flow.
//
// It is a flag rather than a hard rule for one reason: worker apps update on the
// store's schedule, not ours. An old build that still calls /complete straight
// after accepting would get a 409 it has no screen for, stranding the worker
// mid-job with no way to finish.
//
// Default is ON (the new flow). During the worker-app rollout, deploy with
// TRACKING_REQUIRE_JOB_START=false so old builds keep working, then drop the
// override once they're drained. With it off, /complete auto-starts the job so
// `workStartedAt` is never null and the customer's timeline stays coherent.
const REQUIRE_JOB_START = process.env.TRACKING_REQUIRE_JOB_START !== 'false';

module.exports = {
  ARRIVED_RADIUS_M,
  ARRIVED_EXIT_RADIUS_M,
  ARRIVING_RADIUS_M,
  ARRIVING_ETA_MINUTES,
  AVG_SPEED_KMH,
  ROUTE_FACTOR,
  MIN_PING_INTERVAL_MS,
  MAX_ACCURACY_FOR_GEOFENCE_M,
  STALE_AFTER_SECONDS,
  REQUIRE_JOB_START,
};
