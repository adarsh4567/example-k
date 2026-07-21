const Worker = require('../models/Worker');
const SpecializationSubmission = require('../models/SpecializationSubmission');
const s3 = require('../services/s3Service');
const { isValidCategory, isValidSubcategory } = require('../services/serviceCatalog');
const { buildProfilePayload } = require('./profileController');
const { ok, fail } = require('../utils/response');

const MIN_SECONDS = Number(process.env.VIDEO_MIN_SECONDS) || 30;
const MAX_SECONDS = Number(process.env.VIDEO_MAX_SECONDS) || 180;

// Is this (category, subcategory) already an active specialization on the worker?
// Mirrors resolveSelections() in profileController (expertise, falling back to
// onboarding cleaning types).
function isActiveSpecialization(worker, category, subcategory) {
  const expertise = Array.isArray(worker.expertise) && worker.expertise.length
    ? worker.expertise
    : ((worker.work && worker.work.cleaningTypes && worker.work.cleaningTypes.length)
      ? [{ category: 'cleaning', subcategories: worker.work.cleaningTypes }]
      : []);
  const entry = expertise.find((e) => e.category === category);
  return !!(entry && (entry.subcategories || []).includes(subcategory));
}

// POST /api/profile/expertise/video/presigned-url
// body: { category, subcategory, fileName, fileType, fileSize }
async function getPresignedUrl(req, res, next) {
  try {
    const worker = req.worker;
    const { category, subcategory, fileType } = req.body;
    const fileSize = Number(req.body.fileSize);

    if (!isValidCategory(category) || !isValidSubcategory(category, subcategory)) {
      return fail(res, 'Unknown specialization.', 400);
    }
    if (!s3.isAllowedContentType(fileType)) {
      return fail(res, 'Only MP4 and MOV videos are allowed.', 400);
    }
    if (!Number.isFinite(fileSize) || fileSize <= 0) {
      return fail(res, 'A valid fileSize is required.', 422);
    }
    if (fileSize > s3.MAX_BYTES) {
      return fail(res, 'This video is too large (max 200 MB).', 413);
    }

    // Already-held specialization can't be re-submitted. Pending/rejected may
    // (a new submit supersedes the old one) — so we only block "active" here.
    if (isActiveSpecialization(worker, category, subcategory)) {
      return fail(res, 'You already have this specialization.', 409);
    }

    const s3Key = s3.buildSpecializationKey(worker._id, category, subcategory, fileType);
    const { url, expiresIn } = await s3.getPresignedPutUrl({ key: s3Key, contentType: fileType });

    // Canonical field names (the app also accepts several aliases).
    return ok(res, { url, s3Key, expiresInSeconds: expiresIn }, 'Presigned URL generated');
  } catch (err) {
    next(err);
  }
}

// POST /api/profile/expertise/video/submit
// body: { category, subcategory, s3Key, durationSeconds, fileSize }
async function submit(req, res, next) {
  try {
    const worker = req.worker;
    const { category, subcategory, s3Key } = req.body;
    const durationSeconds = Number(req.body.durationSeconds);

    if (!isValidCategory(category) || !isValidSubcategory(category, subcategory)) {
      return fail(res, 'Unknown specialization.', 400);
    }
    if (!s3Key) return fail(res, 's3Key is required.', 422);

    // Ownership: the key must live under this worker's specialization prefix,
    // which also pins the category+subcategory (no cross-skill confusion).
    const prefix = `workers/${worker._id}/specializations/${category}/${subcategory}/`;
    if (!String(s3Key).startsWith(prefix)) {
      return fail(res, 'Invalid upload key.', 403);
    }

    if (!Number.isFinite(durationSeconds) || durationSeconds < MIN_SECONDS || durationSeconds > MAX_SECONDS) {
      return fail(res, `Video must be ${MIN_SECONDS}s–${Math.round(MAX_SECONDS / 60)}min.`, 400);
    }

    if (isActiveSpecialization(worker, category, subcategory)) {
      return fail(res, 'You already have this specialization.', 409);
    }

    // Verify the object actually exists on S3 and respects the limits.
    const head = await s3.headObject(s3Key);
    if (!head.exists) {
      return fail(res, "We couldn't find your uploaded video. Please try again.", 400);
    }
    if (head.contentLength != null && head.contentLength > s3.MAX_BYTES) {
      await s3.deleteObject(s3Key).catch(() => {});
      return fail(res, 'This video is too large (max 200 MB).', 413);
    }
    if (head.contentType && !s3.isAllowedContentType(head.contentType)) {
      return fail(res, 'Unsupported video format.', 400);
    }

    // Supersede any prior pending submission for this skill (allow re-record).
    await SpecializationSubmission.updateMany(
      { worker: worker._id, category, subcategory, status: 'pending' },
      { $set: { status: 'superseded', updatedAt: new Date() } }
    );

    await SpecializationSubmission.create({
      worker: worker._id,
      category,
      subcategory,
      s3Key,
      fileSizeBytes: head.contentLength != null ? head.contentLength : Number(req.body.fileSize) || null,
      durationSeconds,
      status: 'pending',
    });

    const profile = await buildProfilePayload(worker);
    return ok(res, { profile }, 'Submitted for review');
  } catch (err) {
    next(err);
  }
}

module.exports = { getPresignedUrl, submit };
