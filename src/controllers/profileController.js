const { ok, fail } = require('../utils/response');
const { OPERATING_CITIES } = require('../services/placesService');
const {
  SERVICE_CATALOG, isValidCategory, isValidSubcategory, buildExpertiseView,
} = require('../services/serviceCatalog');
const SpecializationSubmission = require('../models/SpecializationSubmission');

// Latest submission status per (category, subcategory) for a worker, so the
// profile can show "pending" / "rejected" pills on not-yet-active skills.
async function buildSubmissionStatusMap(workerId) {
  const subs = await SpecializationSubmission.find({ worker: workerId }).sort({ createdAt: -1 });
  const map = {};
  const seen = new Set();
  for (const s of subs) {
    const k = `${s.category}|${s.subcategory}`;
    if (seen.has(k)) continue; // sorted desc → first seen is the latest
    seen.add(k);
    if (!map[s.category]) map[s.category] = {};
    map[s.category][s.subcategory] = s.status;
  }
  return map;
}

// Resolve a worker's active expertise selections. Falls back to the onboarding
// cleaning types when the worker has never explicitly edited their expertise.
function resolveSelections(worker) {
  if (Array.isArray(worker.expertise) && worker.expertise.length) {
    return worker.expertise.map((e) => ({ category: e.category, subcategories: e.subcategories || [] }));
  }
  const cleaningTypes = (worker.work && worker.work.cleaningTypes) || [];
  return cleaningTypes.length ? [{ category: 'cleaning', subcategories: cleaningTypes }] : [];
}

// Format a 10-digit Indian number as "+91 98765 43210".
function formatPhone(phone) {
  if (!phone || phone.length !== 10) return phone || '';
  return `+91 ${phone.slice(0, 5)} ${phone.slice(5)}`;
}

function initial(name) {
  return name && name.trim() ? name.trim()[0].toUpperCase() : '?';
}

async function buildProfilePayload(worker) {
  const city = (worker.location && worker.location.city) || null;
  const statusMap = await buildSubmissionStatusMap(worker._id);
  return {
    id: worker._id,
    fullName: worker.fullName || null,
    displayInitial: initial(worker.fullName),
    profilePhoto: worker.profilePhoto || null,
    photoUrl: worker.profilePhoto ? worker.profilePhoto : null, // relative; client prepends base URL
    city,
    serviceArea: city,
    phone: worker.phone,
    phoneFormatted: formatPhone(worker.phone),
    rating: worker.rating,               // null => show "New"
    jobsCompleted: worker.jobsCompleted || 0,
    status: worker.status,
    expertise: buildExpertiseView(resolveSelections(worker), statusMap),
    account: {
      serviceArea: city,
      phone: formatPhone(worker.phone),
    },
  };
}

// GET /api/profile
async function getProfile(req, res, next) {
  try {
    return ok(res, { profile: await buildProfilePayload(req.worker) }, 'Profile fetched');
  } catch (err) {
    next(err);
  }
}

// GET /api/profile/catalog — full service catalog (all categories + subcategories)
async function getCatalog(req, res, next) {
  try {
    return ok(res, { catalog: SERVICE_CATALOG }, 'Service catalog');
  } catch (err) {
    next(err);
  }
}

// PUT /api/profile/expertise — replace the worker's active expertise (full desired state)
// Body: { expertise: [ { category, subcategories: [...] }, ... ] }
async function updateExpertise(req, res, next) {
  try {
    const worker = req.worker;
    const { expertise } = req.body;
    if (!Array.isArray(expertise)) {
      return fail(res, 'expertise must be an array of { category, subcategories }', 422);
    }

    const normalized = [];
    const seenCategories = new Set();
    for (const entry of expertise) {
      if (!entry || !isValidCategory(entry.category)) {
        return fail(res, `Invalid service category: ${entry && entry.category}`, 422);
      }
      if (seenCategories.has(entry.category)) {
        return fail(res, `Duplicate category in request: ${entry.category}`, 422);
      }
      seenCategories.add(entry.category);

      const subs = Array.isArray(entry.subcategories) ? entry.subcategories : [];
      const badSub = subs.find((s) => !isValidSubcategory(entry.category, s));
      if (badSub) {
        return fail(res, `Invalid subcategory "${badSub}" for category "${entry.category}"`, 422);
      }
      // Only keep categories that actually have at least one active subcategory.
      const uniqueSubs = Array.from(new Set(subs));
      if (uniqueSubs.length) normalized.push({ category: entry.category, subcategories: uniqueSubs });
    }

    worker.expertise = normalized;

    // Keep onboarding work.cleaningTypes mirrored with the cleaning category so
    // job-matching and the onboarding submit check stay consistent.
    const cleaning = normalized.find((e) => e.category === 'cleaning');
    if (!worker.work) worker.work = {};
    worker.work.cleaningTypes = cleaning ? cleaning.subcategories : [];

    await worker.save();
    return ok(res, { profile: await buildProfilePayload(worker) }, 'Expertise updated');
  } catch (err) {
    next(err);
  }
}

// PUT /api/profile — edit basic profile (the "Edit" button).
// multipart/form-data: fullName?, city?, profilePhoto? (file)
async function updateProfile(req, res, next) {
  try {
    const worker = req.worker;
    const { fullName, city } = req.body;

    if (fullName !== undefined) {
      if (!fullName.trim()) return fail(res, 'Full name cannot be empty', 422);
      worker.fullName = fullName.trim();
    }
    if (city !== undefined) {
      if (!OPERATING_CITIES.includes(city)) {
        return fail(res, `Service area must be one of: ${OPERATING_CITIES.join(', ')}`, 422);
      }
      if (!worker.location) worker.location = {};
      worker.location.city = city;
    }
    if (req.file) {
      worker.profilePhoto = `/uploads/${req.file.filename}`;
    }

    await worker.save();
    return ok(res, { profile: await buildProfilePayload(worker) }, 'Profile updated');
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getProfile, getCatalog, updateExpertise, updateProfile,
  buildProfilePayload, // reused by the specialization-video controller
};
