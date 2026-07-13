/**
 * Aadhaar OTP-based e-KYC (UIDAI / IDfy / Signzy).
 *
 * MOCK: accepts any 12-digit Aadhaar, "sends" an OTP (fixed MOCK_OTP), and on
 *       verification returns a fixed demographic payload + a photo reference.
 * REAL: set AADHAAR_MODE=real and wire the KYC partner's generate-OTP /
 *       submit-OTP endpoints below.
 */

const MODE = process.env.AADHAAR_MODE || 'mock';
const MOCK_OTP = process.env.MOCK_OTP || '123456';

// In mock mode we simulate that Aadhaars ending in an even digit have a
// different registered mobile (to exercise the mismatch UX). Deterministic, no RNG.
function mockMobileMismatch(aadhaar) {
  return Number(aadhaar[aadhaar.length - 1]) % 2 === 0;
}

async function requestAadhaarOtp(aadhaarNumber) {
  if (MODE === 'real') {
    // ── REAL: call partner "generate OTP" API, return their transaction/ref id.
    throw new Error('AADHAAR_MODE=real but no KYC partner implemented in aadhaarService.js');
  }
  // Mock returns a reference id the client echoes back on verify.
  return {
    success: true,
    refId: `mock-aadhaar-${aadhaarNumber.slice(-4)}`,
    message: 'OTP sent to Aadhaar-linked mobile number',
  };
}

async function verifyAadhaarOtp(aadhaarNumber, otp /*, refId */) {
  if (MODE === 'real') {
    // ── REAL: call partner "submit OTP" API; on success it returns demographics + photo.
    throw new Error('AADHAAR_MODE=real but no KYC partner implemented in aadhaarService.js');
  }
  if (otp !== MOCK_OTP) {
    return { success: false, message: 'Invalid Aadhaar OTP' };
  }
  return {
    success: true,
    demographics: {
      name: 'Test Kaaryo Worker',
      dob: '1995-06-15',
      gender: 'M',
    },
    photoRef: `mock-aadhaar-photo-${aadhaarNumber.slice(-4)}`,
    mobileMismatch: mockMobileMismatch(aadhaarNumber),
  };
}

// Aadhaar-based e-sign (Screen 8 consent). Demo-only mock — reuses the same
// fixed OTP as the rest of Aadhaar mock mode, no real UIDAI e-sign call is made.
async function requestEsignOtp() {
  if (MODE === 'real') {
    throw new Error('AADHAAR_MODE=real but no e-sign provider implemented in aadhaarService.js');
  }
  return { success: true, message: 'OTP sent to your Aadhaar-linked mobile for e-sign' };
}

async function verifyEsignOtp(otp) {
  if (MODE === 'real') {
    throw new Error('AADHAAR_MODE=real but no e-sign provider implemented in aadhaarService.js');
  }
  if (otp !== MOCK_OTP) return { success: false, message: 'Invalid e-sign OTP' };
  return { success: true, esignRef: `mock-esign-${Math.round(process.hrtime()[1])}` };
}

module.exports = { requestAadhaarOtp, verifyAadhaarOtp, requestEsignOtp, verifyEsignOtp };
