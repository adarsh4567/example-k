const mongoose = require('mongoose');

/**
 * One document per (worker, taskNumber) for the "Filter 1: Practical Video Task"
 * onboarding step. Kept in its own collection (rather than embedded in Worker) so
 * the reviewer queue and per-video scoring stay easy to query and index.
 *
 * Lifecycle of `status`:
 *   pending      → presigned PUT URL issued, file not yet confirmed on S3
 *   uploaded     → confirmed present on S3 (headObject succeeded)
 *   under_review → a reviewer has opened the worker's submission
 *   approved / rejected → reviewer decision recorded
 *
 * On a re-upload (allowed once after a rejection) the SAME document is reused
 * via upsert on {worker, taskNumber}; `attempt` is bumped so history is legible.
 */

const VIDEO_STATUS = ['pending', 'uploaded', 'under_review', 'approved', 'rejected'];

// Mirrors the mandatory dropdown the reviewer picks from in the admin panel.
const REJECTION_REASONS = [
  'poor_technique',
  'video_quality_too_bad',
  'does_not_show_task',
  'suspicious_staged',
  'other',
];

const workerOnboardingVideoSchema = new mongoose.Schema(
  {
    worker: { type: mongoose.Schema.Types.ObjectId, ref: 'Worker', required: true, index: true },
    taskNumber: { type: Number, enum: [1, 2], required: true },

    // Storage — only the S3 key is persisted, never a presigned URL.
    s3Key: { type: String, required: true },
    fileType: { type: String }, // video/mp4 | video/quicktime
    fileSizeBytes: { type: Number },
    durationSeconds: { type: Number },

    status: { type: String, enum: VIDEO_STATUS, default: 'pending', index: true },
    attempt: { type: Number, default: 1 }, // 1 = first submission, 2 = re-upload after rejection

    // Reviewer scoring (per video)
    reviewer: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    reviewerScore: { type: Number, min: 1, max: 5, default: null },
    reviewerNotes: { type: String, default: null },
    rejectionReason: { type: String, enum: REJECTION_REASONS, default: null },
    reviewedAt: { type: Date, default: null },

    uploadedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Fast lookup / uniqueness: exactly one live record per task per worker.
workerOnboardingVideoSchema.index({ worker: 1, taskNumber: 1 }, { unique: true });

workerOnboardingVideoSchema.statics.STATUS = VIDEO_STATUS;
workerOnboardingVideoSchema.statics.REJECTION_REASONS = REJECTION_REASONS;

module.exports = mongoose.model('WorkerOnboardingVideo', workerOnboardingVideoSchema);
