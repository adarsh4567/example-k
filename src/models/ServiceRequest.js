const mongoose = require('mongoose');

/**
 * A customer's on-demand service request and its dispatch lifecycle.
 *
 *   searching      → offers broadcast to nearby workers, waiting for someone to accept
 *   in_progress    → a worker accepted (first-to-accept-wins); work is ongoing
 *   pending_rating → the worker marked the on-site work done, but the job is
 *                    NOT yet completed — it only becomes `completed` once the
 *                    worker submits their 1-5 rating for the job. The worker
 *                    stays bound to this request (no new offers) throughout.
 *   completed      → rating submitted; job fully closed
 *   cancelled      → the customer cancelled
 *   expired        → no worker accepted within the max radius / waves
 */

const REQUEST_STATUS = ['searching', 'in_progress', 'pending_rating', 'completed', 'cancelled', 'expired'];

// One offer = the request being shown to one worker in a given dispatch wave.
const offerSchema = new mongoose.Schema(
  {
    worker: { type: mongoose.Schema.Types.ObjectId, ref: 'Worker', required: true },
    distanceKm: Number,
    wave: Number,
    status: {
      type: String,
      enum: ['offered', 'accepted', 'declined', 'missed'],
      default: 'offered',
    },
    offeredAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const serviceRequestSchema = new mongoose.Schema(
  {
    customer: {
      name: { type: String, required: true },
      phone: { type: String, required: true },
    },

    category: { type: String, required: true },     // e.g. 'cleaning'
    subcategory: { type: String, default: null },   // optional, e.g. 'kitchen'

    // Free-text description of the job, written by the customer. The only
    // customer-supplied field shown verbatim to the worker as-is.
    jobDescription: { type: String, required: true },

    // DUMMY for now — no customer rating system exists yet. Every request
    // carries this same placeholder so the worker sees a rating pre-accept,
    // mirroring how ride-hailing apps show rider rating to the driver.
    customerRating: { type: Number, default: 4.6 },

    // DUMMY rate-card pricing, computed once at creation (see pricingService).
    pricing: {
      currency: String,
      totalPrice: Number,
      platformFeePercent: Number,
      platformFee: Number,
      workerEarning: Number,
    },

    // Where the service is needed. GeoJSON Point [lng, lat].
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], required: true }, // [lng, lat]
    },
    address: String,

    status: { type: String, enum: REQUEST_STATUS, default: 'searching', index: true },

    // Dispatch state
    radiusKm: Number,          // current search radius
    initialRadiusKm: Number,
    maxRadiusKm: Number,
    wave: { type: Number, default: 0 },
    dispatchExpiresAt: Date,   // when the current wave times out (sweeper acts after this)

    offers: [offerSchema],

    acceptedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Worker', default: null },
    acceptedAt: Date,
    workDoneAt: Date,     // when the worker tapped "Complete" (entered pending_rating)
    completedAt: Date,    // when the rating was submitted (job fully closed)
    cancelledAt: Date,
    expiredAt: Date,

    // The worker's 1-5 rating for this job, submitted at completion. Required
    // to transition pending_rating → completed; null until then.
    jobRating: { type: Number, min: 1, max: 5, default: null },
    ratedAt: Date,

    notes: String,
  },
  { timestamps: true }
);

serviceRequestSchema.index({ location: '2dsphere' });

serviceRequestSchema.statics.STATUS = REQUEST_STATUS;

module.exports = mongoose.model('ServiceRequest', serviceRequestSchema);
