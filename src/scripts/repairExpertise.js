require('dotenv').config();
const connectDB = require('../config/db');
const Worker = require('../models/Worker');
const { isValidSubcategory } = require('../services/serviceCatalog');

/**
 * One-off repair for workers whose active expertise was clobbered by the old
 * (pre-fix) specialization-approval bug.
 *
 * It is MERGE-ONLY — it never removes a skill. It folds any surviving
 * `work.cleaningTypes` back into the `cleaning` expertise entry (recovering
 * skills that were merely *shadowed* by a non-cleaning approval), so the
 * "My Expertise" card comes back with `active: true`.
 *
 * Usage:
 *   node src/scripts/repairExpertise.js                 # dry-run report, all workers
 *   node src/scripts/repairExpertise.js 9876543210      # repair one worker by phone
 *   node src/scripts/repairExpertise.js --all --apply    # repair every affected worker
 *
 * NOTE: if the approved category was 'cleaning', the old bug also overwrote
 * work.cleaningTypes, so the original list is unrecoverable here — those skills
 * must be re-added through the app. This script reports that case, never guesses.
 */

function mergeCleaningTypes(worker) {
  const cleaningTypes = (worker.work && worker.work.cleaningTypes) || [];
  const validSurviving = cleaningTypes.filter((s) => isValidSubcategory('cleaning', s));
  if (!validSurviving.length) return null;

  const expertise = Array.isArray(worker.expertise) ? worker.expertise : [];
  const cleaningEntry = expertise.find((e) => e.category === 'cleaning');
  const existing = cleaningEntry ? (cleaningEntry.subcategories || []) : [];

  // Union — additive only.
  const merged = Array.from(new Set([...existing, ...validSurviving]));
  const changed = merged.length !== existing.length;
  return { merged, changed };
}

(async () => {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const phone = args.find((a) => /^\d{10}$/.test(a));

  try {
    await connectDB();

    const query = phone ? { phone } : {};
    const workers = await Worker.find(query);
    if (!workers.length) {
      console.log(phone ? `No worker found with phone ${phone}` : 'No workers found.');
      process.exit(0);
    }

    let affected = 0;
    for (const worker of workers) {
      const result = mergeCleaningTypes(worker);
      const before = JSON.stringify((worker.expertise || []).map((e) => ({ c: e.category, s: e.subcategories })));

      if (!result) {
        if (phone) console.log(`⚠️  ${worker.phone}: no surviving cleaningTypes to recover. Re-add skills via the app.`);
        continue;
      }
      if (!result.changed) {
        if (phone) console.log(`✅ ${worker.phone}: expertise already consistent, nothing to merge.`);
        continue;
      }

      affected++;
      console.log(`\nWorker ${worker.phone} (${worker.fullName || 'no name'})`);
      console.log(`  before expertise: ${before}`);
      console.log(`  cleaning subcategories after merge: ${JSON.stringify(result.merged)}`);

      if (apply) {
        const expertise = Array.isArray(worker.expertise) ? worker.expertise.slice() : [];
        const idx = expertise.findIndex((e) => e.category === 'cleaning');
        if (idx >= 0) expertise[idx] = { category: 'cleaning', subcategories: result.merged };
        else expertise.push({ category: 'cleaning', subcategories: result.merged });
        worker.expertise = expertise;
        worker.markModified('expertise');
        await worker.save();
        console.log('  💾 applied.');
      }
    }

    if (!apply) {
      console.log(`\nDry run complete — ${affected} worker(s) would change. Re-run with --apply to save.`);
    } else {
      console.log(`\n✅ Repair applied to ${affected} worker(s).`);
    }
    process.exit(0);
  } catch (err) {
    console.error('❌ Repair failed:', err.message);
    process.exit(1);
  }
})();
