/**
 * Locality auto-suggest for Screen 3.
 *
 * MOCK: returns a small canned list of localities per operating city, filtered
 *       by the query string.
 * REAL: set PLACES_MODE=real and call the Google Maps Places Autocomplete API
 *       (restrict by city / components=country:in).
 */

const MODE = process.env.PLACES_MODE || 'mock';

// Cities Kaaryo currently operates in (Screen 3 dropdown).
const OPERATING_CITIES = ['Bengaluru', 'Mumbai', 'Delhi', 'Pune', 'Hyderabad'];

const MOCK_LOCALITIES = {
  Bengaluru: ['Koramangala', 'Indiranagar', 'HSR Layout', 'Whitefield', 'Jayanagar', 'Marathahalli'],
  Mumbai: ['Andheri', 'Bandra', 'Powai', 'Dadar', 'Borivali', 'Thane'],
  Delhi: ['Saket', 'Dwarka', 'Rohini', 'Karol Bagh', 'Lajpat Nagar', 'Janakpuri'],
  Pune: ['Kothrud', 'Hinjewadi', 'Baner', 'Viman Nagar', 'Wakad', 'Kharadi'],
  Hyderabad: ['Gachibowli', 'Madhapur', 'Kukatpally', 'Banjara Hills', 'Hitech City', 'Begumpet'],
};

function listCities() {
  return OPERATING_CITIES;
}

async function suggestLocalities(city, query = '') {
  if (MODE === 'real') {
    // ── REAL: call Google Places Autocomplete restricted to `city`, country IN.
    throw new Error('PLACES_MODE=real but Google Places not implemented in placesService.js');
  }
  const list = MOCK_LOCALITIES[city] || [];
  const q = query.trim().toLowerCase();
  return q ? list.filter((l) => l.toLowerCase().includes(q)) : list;
}

module.exports = { listCities, suggestLocalities, OPERATING_CITIES };
