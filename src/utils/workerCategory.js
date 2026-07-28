/**
 * Which trade is this worker applying for?
 *
 * The original onboarding funnel was cleaning-only (Screen 6 collected
 * `work.cleaningTypes`), so there was no field that distinguished an electrician
 * from a cleaner. `work.primaryCategory` now carries that, defaulting to
 * 'cleaning' so every pre-existing worker keeps its old meaning.
 *
 * Resolution order (first hit wins):
 *   1. work.primaryCategory — set explicitly at Screen 6
 *   2. expertise[0].category — post-onboarding profile selection, for workers
 *      who registered before the field existed
 *   3. 'cleaning' — the historical default
 */

const DEFAULT_CATEGORY = 'cleaning';

function resolveWorkerCategory(worker) {
  if (!worker) return DEFAULT_CATEGORY;

  const primary = worker.work && worker.work.primaryCategory;
  if (primary) return primary;

  if (Array.isArray(worker.expertise) && worker.expertise.length && worker.expertise[0].category) {
    return worker.expertise[0].category;
  }

  return DEFAULT_CATEGORY;
}

module.exports = { resolveWorkerCategory, DEFAULT_CATEGORY };
