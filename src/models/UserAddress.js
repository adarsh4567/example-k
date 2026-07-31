const mongoose = require('mongoose');

/**
 * A customer's saved address.
 *
 * The app keeps its address book in AsyncStorage, which works right up until the
 * customer reinstalls or changes phone — then every saved address is gone and
 * they re-type them at the one moment they wanted to book quickly. This is the
 * server-side copy so that stops happening.
 *
 * The shape mirrors the app's local record exactly (label / locality / city /
 * line / lat / lng) so syncing is a straight mapping rather than a translation.
 * Coordinates are stored as plain numbers, NOT a GeoJSON Point like
 * ServiceRequest.location: nothing searches addresses by proximity — they are
 * copied into a booking, which does its own geo work. A 2dsphere index here
 * would be maintenance for a query no screen makes.
 */

const userAddressSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    label: { type: String, default: 'Home', trim: true, maxlength: 30 },   // Home / Work / …
    locality: { type: String, default: '', trim: true, maxlength: 120 },   // 'Koramangala'
    city: { type: String, default: '', trim: true, maxlength: 80 },        // 'Bengaluru'
    line: { type: String, default: '', trim: true, maxlength: 200 },       // '403, 3rd Block'

    lat: { type: Number, required: true },
    lng: { type: Number, required: true },

    // Which address the app is currently booking against. At most one true per
    // customer, enforced by the controller (a partial unique index would reject
    // the intermediate state of switching rather than allowing it).
    isActive: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// "This customer's address book, newest first" — the only read there is.
userAddressSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('UserAddress', userAddressSchema);
