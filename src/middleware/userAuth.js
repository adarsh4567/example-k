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

    // "Sign out everywhere" (POST /api/user/auth/logout) sets a cutoff instant;
    // anything minted before it is dead. Free to check — the account document is
    // already loaded — which is why this replaces a token blacklist rather than
    // adding a second store and a second lookup to every request.
    //
    // `iat` is whole seconds, so a token issued in the same second as the logout
    // is treated as older and rejected. That errs toward revoking, which is the
    // safe direction: the only way to hit it is to sign in within one second of
    // signing out, and an OTP round trip cannot happen that fast.
    if (user.tokensValidFrom && decoded.iat * 1000 < user.tokensValidFrom.getTime()) {
      return fail(res, 'Session ended. Please sign in again', 401);
    }

    req.user = user;
    next();
  } catch (err) {
    return fail(res, 'Invalid or expired token', 401);
  }
};
