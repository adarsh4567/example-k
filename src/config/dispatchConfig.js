/**
 * Dispatch tuning knobs, in one place.
 *
 * These used to live as consts inside dispatchService. They were lifted out
 * because the customer-facing serializer (utils/requestPayload) needs the same
 * numbers — the search window to render the countdown, the attempt cap to decide
 * whether to show a "Retry" button — and importing dispatchService from a
 * payload builder would create a require cycle (dispatchService already imports
 * the payload builder to push live updates).
 */

// ── Geographic search ───────────────────────────────────────────
const INITIAL_RADIUS_KM = Number(process.env.DISPATCH_INITIAL_RADIUS_KM || 3);
const RADIUS_INCREMENT_KM = Number(process.env.DISPATCH_RADIUS_INCREMENT_KM || 3);
const MAX_RADIUS_KM = Number(process.env.DISPATCH_MAX_RADIUS_KM || 15);
const BATCH_SIZE = Number(process.env.DISPATCH_BATCH_SIZE || 10);

// ── Timing ──────────────────────────────────────────────────────
// A wave is one broadcast at the current radius. When it times out without an
// accept, the radius grows and a new wave goes out.
const WAVE_TIMEOUT_SECONDS = Number(process.env.DISPATCH_WAVE_TIMEOUT_SECONDS || 30);

// The HARD cap on one search attempt — the "1 minute timer" the customer sees.
// It bounds the whole attempt regardless of how many waves fit inside it or
// whether the radius ever reached MAX_RADIUS_KM. When it elapses the request
// expires and the customer is offered a retry.
//
// Radius expansion is therefore opportunistic within the window: with the
// defaults (60s window / 30s waves) an attempt gets two waves — 3 km at t=0 and
// 6 km at t=30 — and expires at t=60. Widening the window or shortening the
// wave timeout buys more waves; neither changes the contract.
const SEARCH_WINDOW_SECONDS = Number(process.env.DISPATCH_SEARCH_WINDOW_SECONDS || 60);

const SWEEP_INTERVAL_SECONDS = Number(process.env.DISPATCH_SWEEP_INTERVAL_SECONDS || 5);

// ── Retry ───────────────────────────────────────────────────────
// Total search attempts allowed on ONE request, the first one included. So the
// default 3 means the customer can press "Retry" twice before the request is
// dead and they have to raise a new one. Bounded so a customer tapping retry in
// a dead zone can't keep a request cycling through geo queries forever.
const MAX_ATTEMPTS = Number(process.env.DISPATCH_MAX_ATTEMPTS || 3);

module.exports = {
  INITIAL_RADIUS_KM,
  RADIUS_INCREMENT_KM,
  MAX_RADIUS_KM,
  BATCH_SIZE,
  WAVE_TIMEOUT_SECONDS,
  SEARCH_WINDOW_SECONDS,
  SWEEP_INTERVAL_SECONDS,
  MAX_ATTEMPTS,
};
