/**
 * Service catalog — the source of truth for the "My Expertise" section of the
 * worker profile. Each main category has editable subcategories. A worker's
 * profile stores only which subcategories they've activated; the catalog is
 * merged in at read time so the app can render every card (active + available).
 *
 * `cleaning` subcategories intentionally match the onboarding cleaning types
 * (see VALID_CLEANING_TYPES in onboardingController) so the two stay in sync.
 */

const SERVICE_CATALOG = [
  {
    key: 'cleaning',
    name: 'Cleaning',
    color: '#3b82f6',
    subcategories: [
      { key: 'basic_home', name: 'Basic home cleaning' },
      { key: 'kitchen', name: 'Kitchen cleaning' },
      { key: 'bathroom', name: 'Bathroom cleaning' },
      { key: 'deep_cleaning', name: 'Deep cleaning' },
      { key: 'sofa_carpet', name: 'Sofa / carpet cleaning' },
      { key: 'office_commercial', name: 'Office / commercial cleaning' },
      { key: 'post_construction', name: 'Post-construction cleaning' },
    ],
  },
  {
    key: 'electrical',
    name: 'Electrical',
    color: '#f59e0b',
    subcategories: [
      { key: 'wiring', name: 'Wiring & repair' },
      { key: 'fan_installation', name: 'Fan installation' },
      { key: 'switch_socket', name: 'Switch & socket' },
      { key: 'appliance_repair', name: 'Appliance repair' },
      { key: 'lighting', name: 'Lighting fixtures' },
    ],
  },
  {
    key: 'cooking',
    name: 'Cooking',
    color: '#ef4444',
    subcategories: [
      { key: 'north_indian', name: 'North Indian' },
      { key: 'south_indian', name: 'South Indian' },
      { key: 'tiffin_service', name: 'Tiffin service' },
      { key: 'party_cooking', name: 'Party / bulk cooking' },
    ],
  },
  {
    key: 'plumbing',
    name: 'Plumbing',
    color: '#8b5cf6',
    subcategories: [
      { key: 'tap_repair', name: 'Tap & faucet repair' },
      { key: 'pipe_fitting', name: 'Pipe fitting' },
      { key: 'drainage', name: 'Drainage & blockage' },
      { key: 'water_tank', name: 'Water tank / motor' },
    ],
  },
  {
    key: 'carpentry',
    name: 'Carpentry',
    color: '#a16207',
    subcategories: [
      { key: 'furniture_repair', name: 'Furniture repair' },
      { key: 'door_window', name: 'Door & window' },
      { key: 'modular_furniture', name: 'Modular furniture' },
      { key: 'polishing', name: 'Polishing' },
    ],
  },
  {
    key: 'ac_repair',
    name: 'AC Repair',
    color: '#0ea5e9',
    subcategories: [
      { key: 'installation', name: 'Installation' },
      { key: 'servicing', name: 'Servicing' },
      { key: 'gas_refill', name: 'Gas refill' },
      { key: 'uninstallation', name: 'Uninstallation' },
    ],
  },
  {
    key: 'painting',
    name: 'Painting',
    color: '#10b981',
    subcategories: [
      { key: 'interior', name: 'Interior painting' },
      { key: 'exterior', name: 'Exterior painting' },
      { key: 'texture', name: 'Texture / designer' },
      { key: 'waterproofing', name: 'Waterproofing' },
    ],
  },
  {
    key: 'pest_control',
    name: 'Pest Control',
    color: '#14b8a6',
    subcategories: [
      { key: 'cockroach', name: 'Cockroach control' },
      { key: 'termite', name: 'Termite control' },
      { key: 'rodent', name: 'Rodent control' },
      { key: 'mosquito', name: 'Mosquito / fly control' },
    ],
  },
];

// Fast lookups keyed by category → Set of valid subcategory keys.
const CATEGORY_MAP = SERVICE_CATALOG.reduce((acc, cat) => {
  acc[cat.key] = new Set(cat.subcategories.map((s) => s.key));
  return acc;
}, {});

const isValidCategory = (key) => Object.prototype.hasOwnProperty.call(CATEGORY_MAP, key);
const isValidSubcategory = (categoryKey, subKey) =>
  isValidCategory(categoryKey) && CATEGORY_MAP[categoryKey].has(subKey);

/**
 * Merge the catalog with a worker's active selections.
 * @param {Array<{category:string, subcategories:string[]}>} selections
 * @returns catalog-shaped array with `active` flags on categories & subcategories.
 */
function buildExpertiseView(selections) {
  const activeMap = {};
  (selections || []).forEach((sel) => {
    if (!sel || !isValidCategory(sel.category)) return;
    activeMap[sel.category] = new Set(
      (sel.subcategories || []).filter((s) => isValidSubcategory(sel.category, s))
    );
  });

  return SERVICE_CATALOG.map((cat) => {
    const activeSubs = activeMap[cat.key] || new Set();
    return {
      category: cat.key,
      name: cat.name,
      color: cat.color,
      active: activeSubs.size > 0,
      subcategories: cat.subcategories.map((s) => ({
        key: s.key,
        name: s.name,
        active: activeSubs.has(s.key),
      })),
    };
  });
}

module.exports = {
  SERVICE_CATALOG,
  isValidCategory,
  isValidSubcategory,
  buildExpertiseView,
};
