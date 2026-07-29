const jwt = require('jsonwebtoken');
const Worker = require('../models/Worker');
const { fail } = require('../utils/response');

// Guards worker-facing onboarding routes. Expects: Authorization: Bearer <token>
module.exports = async function auth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return fail(res, 'Authentication token missing', 401);

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // Customer tokens are signed with the same secret and carry type:'user'.
    // Reject them explicitly rather than relying on the Worker lookup missing.
    if (decoded.type && decoded.type !== 'worker') {
      return fail(res, 'This endpoint requires a worker token', 401);
    }
    const worker = await Worker.findById(decoded.id);
    if (!worker) return fail(res, 'Worker not found', 401);

    req.worker = worker;
    next();
  } catch (err) {
    return fail(res, 'Invalid or expired token', 401);
  }
};
