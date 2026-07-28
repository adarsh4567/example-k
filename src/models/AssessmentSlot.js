const mongoose = require('mongoose');

/**
 * One bookable assessment window at a partner shop.
 *
 * Kept in its own collection (rather than embedded in ShopPartner) because a
 * slot is booked independently and concurrently: booking is a single-document
 * compare-and-swap on `capacityRemaining`, which is only atomic if the slot is
 * its own document. See services/assessmentBookingService.
 *
 * Times are stored twice, on purpose:
 *   slotDate + slotStartTime/slotEndTime → the wall-clock values an admin typed
 *     and the app displays ("Wed 12 Mar, 10:00 AM – 11:00 AM").
 *   startsAt / endsAt → the absolute UTC instants, used for every comparison
 *     (check-in windows, no-show detection, token expiry) so none of that logic
 *     has to reason about timezones.
 */

const assessmentSlotSchema = new mongoose.Schema(
  {
    shopPartner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ShopPartner',
      required: true,
      index: true,
    },

    slotDate: { type: Date, required: true }, // local calendar day, midnight UTC-normalised
    slotStartTime: { type: String, required: true }, // 'HH:MM' (24h, shop-local)
    slotEndTime: { type: String, required: true },   // 'HH:MM' — start + SLOT_DURATION_MINUTES

    startsAt: { type: Date, required: true, index: true }, // absolute instant
    endsAt: { type: Date, required: true },

    maxWorkersPerSlot: { type: Number, default: 1 },
    // Booking counter. The CAS in assessmentBookingService only decrements this
    // when it is >= 1, which is what makes double-booking impossible.
    capacityRemaining: { type: Number, default: 1 },

    // Derived convenience flag for queries/display: capacityRemaining > 0 and
    // not cancelled. Kept in sync by the booking service.
    isAvailable: { type: Boolean, default: true, index: true },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    cancelledAt: { type: Date, default: null },
    cancelledReason: { type: String, default: null },
  },
  { timestamps: true }
);

// The worker-facing slot search: available future slots for a set of partners.
assessmentSlotSchema.index({ shopPartner: 1, startsAt: 1, isAvailable: 1 });

module.exports = mongoose.model('AssessmentSlot', assessmentSlotSchema);
