const mongoose = require('mongoose');

/**
 * A customer's on-demand service request and its dispatch lifecycle.
 *
 *   searching  → offers broadcast to nearby workers, waiting for someone to accept
 *   in_progress→ a worker accepted (first-to-accept-wins); work is ongoing
 *   completed  → the assigned worker marked the job done
 *   cancelled  → the customer cancelled
 *   expired    → no worker accepted within the max radius / waves
 */

const REQUEST_STATUS = ['searching', 'in_progress', 'completed', 'cancelled', 'expired'];

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
    completedAt: Date,
    cancelledAt: Date,
    expiredAt: Date,

    notes: String,
  },
  { timestamps: true }
);

serviceRequestSchema.index({ location: '2dsphere' });

serviceRequestSchema.statics.STATUS = REQUEST_STATUS;

module.exports = mongoose.model('ServiceRequest', serviceRequestSchema);
