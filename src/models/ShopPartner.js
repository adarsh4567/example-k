const mongoose = require('mongoose');

/**
 * An electrical shop Kaaryo has tied up with to run in-person skill assessments
 * (Filter 3). The shop owner has no app — they are reached by SMS/WhatsApp and
 * submit feedback through a token-authenticated web form.
 *
 * Status lifecycle:
 *   active     → accepting assessments, slots visible to workers
 *   paused     → temporarily hidden (manual, or auto on a low quality score)
 *   terminated → removed from the partner network; future slots are cancelled
 *
 * `stats` are denormalised running counters (cheap for the partner dashboard);
 * `qualityHistory` holds the monthly snapshots produced by
 * services/partnerQualityService. The snapshots are embedded rather than kept in
 * their own collection because they are strictly bounded (12 rows per partner
 * per year) and are always read together with the partner.
 */

const SHOP_PARTNER_STATUS = ['active', 'paused', 'terminated'];

// One month's downstream-performance snapshot for this partner.
const qualitySnapshotSchema = new mongoose.Schema(
  {
    month: { type: Date, required: true }, // first day of the month covered
    totalWorkersAssessed: { type: Number, default: 0 },
    totalWorkersApproved: { type: Number, default: 0 },
    totalWorkersRejected: { type: Number, default: 0 },
    // Average Kaaryo rating of the workers this partner approved.
    avgRatingOfApprovedWorkers: { type: Number, default: null },
    workersWhoCausedComplaints: { type: Number, default: 0 },
    partnerQualityScore: { type: Number, default: null },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const shopPartnerSchema = new mongoose.Schema(
  {
    shopName: { type: String, required: true, trim: true },
    ownerName: { type: String, required: true, trim: true },
    ownerPhone: { type: String, required: true, index: true },
    ownerEmail: { type: String, default: null },

    city: { type: String, required: true, index: true },
    locality: { type: String, default: '' },
    fullAddress: { type: String, required: true },

    // GeoJSON Point [lng, lat] — powers the worker's "slots near me" $geoNear
    // and the 500 m check-in geofence. Stored in the same shape as Worker /
    // TrialJob / ServiceRequest so all geo queries look alike.
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], required: true }, // [lng, lat]
    },
    googleMapsLink: { type: String, default: null },

    status: { type: String, enum: SHOP_PARTNER_STATUS, default: 'active', index: true },

    // How this owner prefers to receive the feedback link.
    feedbackChannel: { type: String, enum: ['sms', 'whatsapp', 'both'], default: 'both' },

    // Per-assessment payout split. Defaults come from config/assessmentConfig
    // at creation time so an individual partner can be negotiated separately.
    payment: {
      perAssessment: { type: Number, default: 500 },
      upfront: { type: Number, default: 300 },
      deferred: { type: Number, default: 200 },
      // Where payouts go. Free-text: this is an ops record, not a gateway integration.
      method: { type: String, default: null }, // 'upi' | 'bank_transfer' | …
      upiId: { type: String, default: null },
    },

    // Denormalised running counters, maintained as assessments progress.
    stats: {
      totalAssessmentsConducted: { type: Number, default: 0 },
      totalWorkersApproved: { type: Number, default: 0 },
      totalWorkersRejected: { type: Number, default: 0 },
      totalNoShows: { type: Number, default: 0 },
      averageDownstreamRating: { type: Number, default: null },
      partnerQualityScore: { type: Number, default: null },
      lastAssessmentAt: { type: Date, default: null },
    },

    qualityHistory: [qualitySnapshotSchema],

    // Set when a low quality score auto-paused/terminated the partner, so ops can
    // tell an automatic action apart from a manual one.
    autoActionedAt: { type: Date, default: null },
    autoActionReason: { type: String, default: null },

    onboardedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// "Shops near this worker" — same index pattern as Worker.currentLocation.
shopPartnerSchema.index({ location: '2dsphere' });
shopPartnerSchema.index({ city: 1, status: 1 });

shopPartnerSchema.statics.STATUS = SHOP_PARTNER_STATUS;

// Convenience for API payloads: expose lat/lng rather than GeoJSON ordering.
shopPartnerSchema.methods.latLng = function latLng() {
  const c = (this.location && this.location.coordinates) || [];
  return { lat: c[1] ?? null, lng: c[0] ?? null };
};

module.exports = mongoose.model('ShopPartner', shopPartnerSchema);
