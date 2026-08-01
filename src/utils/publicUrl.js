/**
 * Turn a server-local file reference into an absolute, publicly-loadable URL —
 * the shape a bare `<Image source={{ uri }}>` can load with no Authorization
 * header and no base-URL logic of its own on the client.
 *
 * Needed because stored file references in this codebase (e.g.
 * `Worker.profilePhoto`, written by onboardingController/profileController as
 * `/uploads/<filename>`) are relative paths served statically off this same
 * process (`app.use('/uploads', express.static(...))` in server.js) — fine for
 * a client that already knows the API's base URL and prepends it itself (the
 * worker app's own profile screen does exactly that), but not for a payload
 * meant to be handed to `Image` verbatim.
 *
 * `PUBLIC_BASE_URL` follows the same env-with-localhost-fallback shape already
 * used by config/trialConfig.js and config/assessmentConfig.js for the same
 * "what's our own public URL" question — kept local here rather than importing
 * either of those, since neither name fits a worker photo shown on a normal
 * booking, and a require from this file back into trial/assessment config
 * would be a stranger dependency than the few extra characters of duplication.
 */
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 5000}`;

/**
 * @param {string|null|undefined} ref  a relative path (`/uploads/x.jpg`), an
 *   already-absolute URL (passed through untouched — e.g. a future S3/CDN
 *   URL), or nullish (returns null).
 */
function toPublicUrl(ref) {
  if (!ref) return null;
  if (/^https?:\/\//i.test(ref)) return ref;
  return `${PUBLIC_BASE_URL}${ref.startsWith('/') ? ref : `/${ref}`}`;
}

module.exports = { toPublicUrl, PUBLIC_BASE_URL };
