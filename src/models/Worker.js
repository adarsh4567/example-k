const mongoose = require('mongoose');

/**
 * A single Worker document accumulates data across all onboarding screens.
 * `status` tracks the application lifecycle; `onboardingStep` tracks how far
 * the worker has progressed through the screens.
 */

const APPLICATION_STATUS = [
  'in_progress',   // still filling screens
  'submitted',     // hit "submit" on Screen 9
  'under_review',  // in admin queue
  'manual_review', // flagged (e.g. face-match failed twice)
  'info_requested',// admin asked for missing info
  'approved',
  'rejected',
];

// Screens the worker moves through. Used to resume onboarding and drive the tracker.
const ONBOARDING_STEPS = [
  'phone',        // 1 done
  'personal',     // 2
  'location',     // 3
  'aadhaar',      // 4
  'face_match',   // 5
  'work_details', // 6
  'references',   // 7
  'consent',      // 8
  'submitted',    // 9
];

const prevPlatformSchema = new mongoose.Schema(
  {
    name: String,
    duration: String,
  },
  { _id: false }
);

const referenceSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    relationship: {
      type: String,
      enum: ['past_employer', 'neighbor', 'known_family', 'other'],
      required: true,
    },
    phone: { type: String, required: true },
  },
  { _id: false }
);

// Worker's active expertise selection: main category + chosen subcategory keys.
// Only active selections are stored; the full catalog is merged in at read time.
const expertiseSchema = new mongoose.Schema(
  {
    category: { type: String, required: true }, // e.g. 'cleaning'
    subcategories: [String],                    // e.g. ['basic_home', 'kitchen']
  },
  { _id: false }
);

const reviewLogSchema = new mongoose.Schema(
  {
    action: String,          // approved / rejected / info_requested / flagged / submitted
    by: String,              // admin email or 'system'
    message: String,
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const workerSchema = new mongoose.Schema(
  {
    // Screen 1
    phone: { type: String, required: true, unique: true, index: true },
    phoneVerified: { type: Boolean, default: false },

    status: { type: String, enum: APPLICATION_STATUS, default: 'in_progress' },
    onboardingStep: { type: String, enum: ONBOARDING_STEPS, default: 'phone' },

    // Screen 2 — basic personal details
    fullName: String,
    dob: Date,
    gender: { type: String, enum: ['male', 'female', 'prefer_not_to_say'] },
    profilePhoto: String, // stored file path/URL

    // Screen 3 — location
    location: {
      city: String,
      area: String,
      pincode: String,
      address: String,
      travelRadiusKm: { type: Number, enum: [1, 2, 5, 10] },
    },

    // Screen 4 — Aadhaar (OTP based). Never store the raw number in the clear in prod.
    aadhaar: {
      last4: String,           // only last 4 kept for reference
      verified: { type: Boolean, default: false },
      nameFromAadhaar: String,
      dobFromAadhaar: String,
      photoRef: String,        // reference to Aadhaar photo returned by KYC partner
      mobileMismatch: { type: Boolean, default: false },
      verifiedAt: Date,
    },

    // Screen 5 — face match
    faceMatch: {
      selfiePath: String,
      status: { type: String, enum: ['pending', 'success', 'failed', 'manual_review'], default: 'pending' },
      attempts: { type: Number, default: 0 },
    },

    // Screen 6 — work details & skills
    work: {
      cleaningTypes: [String],
      experience: { type: String, enum: ['lt_1', '1_3', '3_5', 'gt_5'] },
      workedBefore: Boolean,
      prevPlatform: prevPlatformSchema,
      ownsEquipment: Boolean,
      equipmentList: [String],
      workingHours: { type: String, enum: ['morning', 'afternoon', 'evening', 'flexible'] },
      workingDays: { type: String, enum: ['weekdays', 'weekends', 'all_days'] },
    },

    // Screen 7 — references
    references: [referenceSchema],
    referenceConsent: { type: Boolean, default: false },

    // Screen 8 — background check consent
    consent: {
      backgroundCheck: { type: Boolean, default: false },
      infoAccurate: { type: Boolean, default: false },
      signaturePath: String,
      signedAt: Date,
      // Set by the mock Aadhaar e-sign OTP flow (demo only) before final consent submission.
      esignVerified: { type: Boolean, default: false },
    },

    // Screen 9 — submission / referral
    referralCode: String,
    submittedAt: Date,

    // ── Profile (editable anytime, post-onboarding) ──
    // Services the worker offers. Backfilled from work.cleaningTypes when empty.
    expertise: [expertiseSchema],
    // Shown on the profile card. Populated over time by the platform (jobs/ratings).
    rating: { type: Number, default: null },      // null = "New", no ratings yet
    jobsCompleted: { type: Number, default: 0 },

    // ── Live dispatch state (for the on-demand service-request engine) ──
    // GeoJSON Point [longitude, latitude]. Set via the availability heartbeat.
    currentLocation: {
      type: { type: String, enum: ['Point'] },
      coordinates: { type: [Number] }, // [lng, lat]
    },
    availability: {
      isOnline: { type: Boolean, default: false },
      lastSeenAt: Date,
    },
    // The service request the worker is currently assigned to (null = free to receive offers).
    activeRequest: { type: mongoose.Schema.Types.ObjectId, ref: 'ServiceRequest', default: null },

    reviewLog: [reviewLogSchema],
  },
  { timestamps: true }
);

workerSchema.statics.STATUS = APPLICATION_STATUS;
workerSchema.statics.STEPS = ONBOARDING_STEPS;

// Geospatial index for "nearby workers" dispatch queries ($geoNear).
// Documents without currentLocation.coordinates are simply not indexed.
workerSchema.index({ currentLocation: '2dsphere' });

module.exports = mongoose.model('Worker', workerSchema);
