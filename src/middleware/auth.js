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
    let workerQuery = Worker.findById(decoded.id);
    // Jobs/location is the highest-frequency worker route and does not need the
    // large onboarding, reference, review, or assessment subdocuments.
    if (req.baseUrl === '/api/jobs') {
      workerQuery = workerQuery.select(
        'status activeRequest availability currentLocation jobsCompleted phone fullName rating'
      );
    } else if (req.baseUrl === '/api/earnings') {
      workerQuery = workerQuery.select('_id');
    }
    const worker = await workerQuery;
    if (!worker) return fail(res, 'Worker not found', 401);

    req.worker = worker;
    next();
  } catch (err) {
    return fail(res, 'Invalid or expired token', 401);
  }
};
