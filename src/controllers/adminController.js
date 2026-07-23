const jwt = require('jsonwebtoken');
const Admin = require('../models/Admin');
const Worker = require('../models/Worker');
const { notifyWorker } = require('../services/notificationService');
const { transitionWorker } = require('../services/workerStatusService');
const { TRIAL_ENABLED } = require('../config/trialConfig');
const { ok, fail } = require('../utils/response');

// POST /api/admin/login  { email, password }
async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    if (!email || !password) return fail(res, 'Email and password are required', 422);

    const admin = await Admin.findOne({ email: String(email).toLowerCase() });
    if (!admin) return fail(res, 'Invalid credentials', 401);

    const valid = await admin.verifyPassword(password);
    if (!valid) return fail(res, 'Invalid credentials', 401);

    const token = jwt.sign({ id: admin._id, role: admin.role }, process.env.ADMIN_JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || '30d',
    });
    return ok(res, { token, admin: { id: admin._id, email: admin.email, role: admin.role } }, 'Logged in');
  } catch (err) {
    next(err);
  }
}

// GET /api/admin/workers?status=submitted&page=1&limit=20
async function listWorkers(req, res, next) {
  try {
    const { status } = req.query;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Number(req.query.limit) || 20);

    const query = status ? { status } : {};
    const [total, workers] = await Promise.all([
      Worker.countDocuments(query),
      Worker.find(query)
        .select('phone fullName status onboardingStep location.city submittedAt createdAt')
        .sort({ submittedAt: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
    ]);

    return ok(res, { total, page, limit, workers }, 'Workers fetched');
  } catch (err) {
    next(err);
  }
}

// GET /api/admin/workers/:id  — full application detail
async function getWorker(req, res, next) {
  try {
    const worker = await Worker.findById(req.params.id);
    if (!worker) return fail(res, 'Worker not found', 404);
    return ok(res, { worker }, 'Worker detail');
  } catch (err) {
    next(err);
  }
}

// Shared guard: only submitted / under_review / manual_review / info_requested apps are decidable.
function ensureDecidable(worker, res) {
  const decidable = ['submitted', 'under_review', 'manual_review', 'info_requested'];
  if (!decidable.includes(worker.status)) {
    fail(res, `Cannot action a worker whose status is "${worker.status}"`, 409);
    return false;
  }
  return true;
}

// POST /api/admin/workers/:id/approve
// Clears application review. When the trial filter is enabled (default), this
// does NOT fully approve the worker — it moves them to `pending_trial`, and the
// worker only reaches `approved` after passing the trial job (Filter 2). With
// TRIAL_ENABLED=false it keeps its legacy meaning (straight to `approved`).
async function approveWorker(req, res, next) {
  try {
    const worker = await Worker.findById(req.params.id);
    if (!worker) return fail(res, 'Worker not found', 404);
    if (!ensureDecidable(worker, res)) return;

    if (TRIAL_ENABLED) {
      await transitionWorker(worker, 'pending_trial', {
        actor: req.admin.email,
        reason: req.body.message || 'Application review cleared — trial job pending',
      });
      await notifyWorker(worker, {
        title: 'Application review cleared ✅',
        message: 'Great news — the next step is a short trial job. We\'ll assign one to you shortly.',
      });
      return ok(res, { worker: { id: worker._id, status: worker.status } }, 'Worker moved to pending trial');
    }

    // Legacy path: no trial filter — approve directly.
    worker.status = 'approved';
    worker.reviewLog.push({ action: 'approved', by: req.admin.email, message: req.body.message || '' });
    await worker.save();

    await notifyWorker(worker, {
      title: 'Application Approved 🎉',
      message: 'Welcome to Kaaryo! Your worker application has been approved.',
    });

    return ok(res, { worker: { id: worker._id, status: worker.status } }, 'Worker approved');
  } catch (err) {
    next(err);
  }
}

// POST /api/admin/workers/:id/reject  { reason }
async function rejectWorker(req, res, next) {
  try {
    const { reason } = req.body;
    if (!reason || !reason.trim()) return fail(res, 'A rejection reason is required', 422);

    const worker = await Worker.findById(req.params.id);
    if (!worker) return fail(res, 'Worker not found', 404);
    if (!ensureDecidable(worker, res)) return;

    worker.status = 'rejected';
    worker.reviewLog.push({ action: 'rejected', by: req.admin.email, message: reason.trim() });
    await worker.save();

    await notifyWorker(worker, {
      title: 'Application Update',
      message: `Unfortunately your application was not approved. Reason: ${reason.trim()}`,
    });

    return ok(res, { worker: { id: worker._id, status: worker.status } }, 'Worker rejected');
  } catch (err) {
    next(err);
  }
}

// POST /api/admin/workers/:id/request-info  { message }
async function requestInfo(req, res, next) {
  try {
    const { message } = req.body;
    if (!message || !message.trim()) return fail(res, 'A message describing what is missing is required', 422);

    const worker = await Worker.findById(req.params.id);
    if (!worker) return fail(res, 'Worker not found', 404);
    if (!ensureDecidable(worker, res)) return;

    worker.status = 'info_requested';
    worker.reviewLog.push({ action: 'info_requested', by: req.admin.email, message: message.trim() });
    await worker.save();

    await notifyWorker(worker, {
      title: 'Action needed on your Kaaryo application',
      message: message.trim(),
    });

    return ok(res, { worker: { id: worker._id, status: worker.status } }, 'Information requested from worker');
  } catch (err) {
    next(err);
  }
}

// POST /api/admin/workers/:id/move-to-review  — pull a submitted app into the review stage
async function moveToReview(req, res, next) {
  try {
    const worker = await Worker.findById(req.params.id);
    if (!worker) return fail(res, 'Worker not found', 404);
    if (worker.status !== 'submitted') {
      return fail(res, `Only submitted applications can be moved to review (current: ${worker.status})`, 409);
    }
    worker.status = 'under_review';
    worker.reviewLog.push({ action: 'under_review', by: req.admin.email, message: '' });
    await worker.save();
    return ok(res, { worker: { id: worker._id, status: worker.status } }, 'Moved to under review');
  } catch (err) {
    next(err);
  }
}

module.exports = {
  login, listWorkers, getWorker, approveWorker, rejectWorker, requestInfo, moveToReview,
};
