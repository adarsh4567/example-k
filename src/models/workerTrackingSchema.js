const mongoose = require('mongoose');

/**
 * The assigned worker's LIVE position on one job, plus the server's verdict on
 * how close they are.
 *
 * Embedded on both ServiceRequest and TrialJob from this one definition so the
 * two flows cannot drift: the customer app renders the same map component for a
 * normal booking and a trial, and it would break the moment one of them spelled
 * a field differently.
 *
 * Why this lives on the JOB and not on the Worker
 * ------------------------------------------------
 * Worker.currentLocation already exists — it's the availability heartbeat that
 * dispatch geo-queries against. It is deliberately NOT reused here:
 *
 *   • It is overwritten by every heartbeat regardless of job, so the moment a
 *     worker finishes and moves on, the finished job's "where were they" is
 *     gone. Support cannot answer "did they actually turn up?" from it.
 *   • Arrival is a property of a (worker, job) pair, not of a worker. The same
 *     coordinates mean "arrived" for one job and "20 minutes away" for another.
 *   • Reading it would leak a worker's position to whoever holds any job of
 *     theirs, including finished ones. Scoped to the job, the customer only ever
 *     sees the worker while the worker is on their way to them.
 *
 * Only the LATEST ping is kept — one UPDATE per ping, no append. The customer
 * needs a dot, not a trail. If support/dispute resolution ever needs a
 * replayable route, that's a separate collection; don't build it speculatively.
 */

const ARRIVAL_STATUS = ['en_route', 'arriving_soon', 'arrived'];

const workerTrackingSchema = new mongoose.Schema(
  {
    // Last accepted GPS fix. Stored as plain lat/lng rather than a GeoJSON Point
    // because nothing geo-QUERIES this field — it is read by id, always. A
    // 2dsphere index on it would be pure write cost for no read.
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },

    heading: { type: Number, default: null },   // degrees 0-360, for a rotated marker
    speedKmh: { type: Number, default: null },
    accuracyMeters: { type: Number, default: null },

    updatedAt: { type: Date, default: null },   // when that fix was accepted
    pings: { type: Number, default: 0 },        // accepted pings this job (ops/debug)

    // ── Server's verdict, recomputed on every accepted ping ──────
    // The client renders these; it never re-derives arrival from raw coordinates.
    // Otherwise one bad fix would flip the badge to "Arrived" on the customer's
    // phone alone while the server — and therefore the worker's app, the timeline
    // and any notification — still said otherwise.
    distanceMeters: { type: Number, default: null },
    etaMinutes: { type: Number, default: null },
    // 'estimate'  → straight-line distance ÷ assumed speed (see trackingConfig)
    // 'directions'→ a real routing provider answered (not wired in yet)
    etaSource: { type: String, enum: ['estimate', 'directions', null], default: null },

    arrivalStatus: { type: String, enum: ARRIVAL_STATUS, default: 'en_route' },
    arrivalStatusChangedAt: { type: Date, default: null },
  },
  { _id: false }
);

module.exports = { workerTrackingSchema, ARRIVAL_STATUS };
