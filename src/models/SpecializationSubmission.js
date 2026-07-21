const mongoose = require('mongoose');

/**
 * "Add a specialization" via demo video. One document per video a worker submits
 * for a (category, subcategory). The specialization is NOT granted on upload —
 * only when a reviewer approves it (which then writes into worker.expertise).
 *
 * status lifecycle:
 *   pending    → video uploaded + verified, awaiting review
 *   approved   → reviewer accepted; subcategory added to worker.expertise
 *   rejected   → reviewer declined (rejectionReason set); worker may re-submit
 *   superseded → replaced by a newer pending submission for the same skill
 *
 * MongoDB counterpart of the plan's `specialization_submissions` table.
 */

const SUBMISSION_STATUS = ['pending', 'approved', 'rejected', 'superseded'];

const specializationSubmissionSchema = new mongoose.Schema(
  {
    worker: { type: mongoose.Schema.Types.ObjectId, ref: 'Worker', required: true, index: true },

    category: { type: String, required: true },     // e.g. 'cleaning'
    subcategory: { type: String, required: true },   // e.g. 'deep_cleaning'

    s3Key: { type: String, required: true },
    fileSizeBytes: { type: Number },
    durationSeconds: { type: Number },

    status: { type: String, enum: SUBMISSION_STATUS, default: 'pending', index: true },

    reviewer: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    rejectionReason: { type: String, default: null },
    reviewNotes: { type: String, default: null },
    reviewedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Fast lookup of a worker's submissions for one skill (status derivation, supersede).
specializationSubmissionSchema.index({ worker: 1, category: 1, subcategory: 1, createdAt: -1 });

specializationSubmissionSchema.statics.STATUS = SUBMISSION_STATUS;

module.exports = mongoose.model('SpecializationSubmission', specializationSubmissionSchema);
