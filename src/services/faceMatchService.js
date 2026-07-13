/**
 * Face match between the live selfie (Screen 5) and the Aadhaar photo (Screen 4).
 *
 * MOCK: returns success by default. Set FACE_MATCH_FORCE_FAIL=true in .env to
 *       force failure and exercise the retry / manual-review path.
 * REAL: set FACE_MATCH_MODE=real and call HyperVerge / IDfy / AWS Rekognition.
 *
 * NOTE: per the spec, the numeric match score is NEVER returned to the client.
 * This function returns only { matched: boolean }.
 */

const MODE = process.env.FACE_MATCH_MODE || 'mock';
const FORCE_FAIL = String(process.env.FACE_MATCH_FORCE_FAIL).toLowerCase() === 'true';

async function matchFaces(selfiePath, aadhaarPhotoRef) {
  if (MODE === 'real') {
    // ── REAL: upload selfie + reference to the face-match API, read its score,
    //          apply your threshold, and return only the boolean.
    throw new Error('FACE_MATCH_MODE=real but no provider implemented in faceMatchService.js');
  }
  return { matched: !FORCE_FAIL };
}

module.exports = { matchFaces };
