// Uniform response helpers.
const ok = (res, data = {}, message = 'OK', code = 200) =>
  res.status(code).json({ success: true, message, ...data });

const fail = (res, message = 'Error', code = 400, extra = {}) =>
  res.status(code).json({ success: false, message, ...extra });

module.exports = { ok, fail };
