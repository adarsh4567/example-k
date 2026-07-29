const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { fail } = require('../utils/response');

/**
 * Guards customer-facing routes. Expects: Authorization: Bearer <token>
 *
 * Worker and user tokens are signed with the SAME secret, so the `type` claim is
 * what keeps them apart — a worker token must never unlock a user route (its id
 * would be a Worker _id and could collide with nothing here, but the claim check
 * makes the boundary explicit rather than incidental).
 */
module.exports = async function userAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return fail(res, 'Authentication token missing', 401);

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.type !== 'user') return fail(res, 'This endpoint requires a user token', 401);

    const user = await User.findById(decoded.id);
    if (!user) return fail(res, 'User not found', 401);
    if (user.status === 'blocked') return fail(res, 'This account has been blocked', 403);

    req.user = user;
    next();
  } catch (err) {
    return fail(res, 'Invalid or expired token', 401);
  }
};
