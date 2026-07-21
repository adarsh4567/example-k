const Worker = require('../models/Worker');
const SpecializationSubmission = require('../models/SpecializationSubmission');
const s3 = require('../services/s3Service');
const { categoryName, subcategoryName } = require('../services/serviceCatalog');
const { notifyWorker } = require('../services/notificationService');
const { ok, fail } = require('../utils/response');

// Grant the specialization on the worker: add the subcategory to their active
// expertise (creating the category entry if needed) and keep the onboarding
// cleaningTypes mirror consistent, exactly like PUT /api/profile/expertise.
//
// IMPORTANT: many workers have no explicit `expertise` array — their skills
// resolve implicitly from `work.cleaningTypes`. We must materialise that same
// fallback here (mirrors resolveSelections in profileController), otherwise the
// first approval would overwrite the implicit skills and wipe them out.
function grantSpecialization(worker, category, subcategory) {
  const current = (Array.isArray(worker.expertise) && worker.expertise.length)
    ? worker.expertise.map((e) => ({ category: e.category, subcategories: (e.subcategories || []).slice() }))
    : ((worker.work && worker.work.cleaningTypes && worker.work.cleaningTypes.length)
      ? [{ category: 'cleaning', subcategories: worker.work.cleaningTypes.slice() }]
      : []);

  let entry = current.find((e) => e.category === category);
  if (!entry) {
    entry = { category, subcategories: [] };
    current.push(entry);
  }
  if (!entry.subcategories.includes(subcategory)) {
    entry.subcategories.push(subcategory);
  }

  worker.expertise = current;

  if (category === 'cleaning') {
    if (!worker.work) worker.work = {};
    worker.work.cleaningTypes = entry.subcategories.slice();
  }
  worker.markModified('expertise');
}

// GET /api/admin/specialization-submissions?status=pending&page=1&limit=20
async function list(req, res, next) {
  try {
    const status = req.query.status || 'pending';
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Number(req.query.limit) || 20);

    const [total, subs] = await Promise.all([
      SpecializationSubmission.countDocuments({ status }),
      SpecializationSubmission.find({ status })
        .sort({ createdAt: 1 }) // oldest first
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('worker', 'phone fullName location.city'),
    ]);

    const submissions = subs.map((s) => ({
      id: s._id,
      worker: s.worker
        ? {
          id: s.worker._id,
          fullName: s.worker.fullName,
          phone: s.worker.phone,
          city: s.worker.location && s.worker.location.city,
        }
        : null,
      category: s.category,
      categoryName: categoryName(s.category),
      subcategory: s.subcategory,
      subcategoryName: subcategoryName(s.category, s.subcategory),
      durationSeconds: s.durationSeconds || null,
      fileSizeBytes: s.fileSizeBytes || null,
      status: s.status,
      createdAt: s.createdAt,
    }));

    return ok(res, { total, page, limit, submissions }, 'Specialization submissions');
  } catch (err) {
    next(err);
  }
}

// GET /api/admin/specialization-submissions/:id/video — presigned streaming URL
async function getVideo(req, res, next) {
  try {
    const sub = await SpecializationSubmission.findById(req.params.id);
    if (!sub) return fail(res, 'Submission not found', 404);
    const url = await s3.getPresignedGetUrl(sub.s3Key);
    return ok(res, { url, expiresInSeconds: s3.GET_URL_TTL }, 'Playback URL');
  } catch (err) {
    next(err);
  }
}

// POST /api/admin/specialization-submissions/:id/approve  { notes? }
async function approve(req, res, next) {
  try {
    const sub = await SpecializationSubmission.findById(req.params.id);
    if (!sub) return fail(res, 'Submission not found', 404);
    if (sub.status !== 'pending') {
      return fail(res, `Only pending submissions can be approved (current: ${sub.status})`, 409);
    }

    const worker = await Worker.findById(sub.worker);
    if (!worker) return fail(res, 'Worker not found', 404);

    sub.status = 'approved';
    sub.reviewer = req.admin._id;
    sub.reviewNotes = req.body.notes || null;
    sub.reviewedAt = new Date();
    await sub.save();

    grantSpecialization(worker, sub.category, sub.subcategory);
    await worker.save();

    const skill = subcategoryName(sub.category, sub.subcategory);
    await notifyWorker(worker, {
      title: 'Specialization approved 🎉',
      message: `Your "${skill}" specialization has been approved.`,
    });

    return ok(res, { id: sub._id, status: sub.status }, 'Specialization approved');
  } catch (err) {
    next(err);
  }
}

// POST /api/admin/specialization-submissions/:id/reject  { reason, notes? }
async function reject(req, res, next) {
  try {
    const { reason } = req.body;
    if (!reason || !reason.trim()) return fail(res, 'A rejection reason is required', 422);

    const sub = await SpecializationSubmission.findById(req.params.id);
    if (!sub) return fail(res, 'Submission not found', 404);
    if (sub.status !== 'pending') {
      return fail(res, `Only pending submissions can be rejected (current: ${sub.status})`, 409);
    }

    sub.status = 'rejected';
    sub.reviewer = req.admin._id;
    sub.rejectionReason = reason.trim();
    sub.reviewNotes = req.body.notes || null;
    sub.reviewedAt = new Date();
    await sub.save();

    const worker = await Worker.findById(sub.worker);
    if (worker) {
      const skill = subcategoryName(sub.category, sub.subcategory);
      await notifyWorker(worker, {
        title: 'Specialization not approved',
        message: `Your "${skill}" video was not approved. Reason: ${reason.trim()}. You can record and submit a new video.`,
      });
    }

    return ok(res, { id: sub._id, status: sub.status }, 'Specialization rejected');
  } catch (err) {
    next(err);
  }
}

module.exports = { list, getVideo, approve, reject };
