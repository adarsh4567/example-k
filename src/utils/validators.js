// Small, dependency-free validators shared across controllers.

const isValidPhone = (v) => /^[6-9]\d{9}$/.test(String(v || '').trim());

const isValidAadhaar = (v) => /^\d{12}$/.test(String(v || '').trim());

const isValidPincode = (v) => /^\d{6}$/.test(String(v || '').trim());

const isValidOtp = (v) => /^\d{4,6}$/.test(String(v || '').trim());

// Returns whole-year age from a DOB (Date or parseable string), or null if invalid.
function ageFromDob(dob) {
  const d = new Date(dob);
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age;
}

module.exports = { isValidPhone, isValidAadhaar, isValidPincode, isValidOtp, ageFromDob };
