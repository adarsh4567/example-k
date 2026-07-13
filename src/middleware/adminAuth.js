const jwt = require('jsonwebtoken');
const Admin = require('../models/Admin');
const { fail } = require('../utils/response');

// Guards admin routes. Expects: Authorization: Bearer <admin token>
module.exports = async function adminAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return fail(res, 'Admin token missing', 401);

    const decoded = jwt.verify(token, process.env.ADMIN_JWT_SECRET);
    const admin = await Admin.findById(decoded.id);
    if (!admin) return fail(res, 'Admin not found', 401);

    req.admin = admin;
    next();
  } catch (err) {
    return fail(res, 'Invalid or expired admin token', 401);
  }
};
