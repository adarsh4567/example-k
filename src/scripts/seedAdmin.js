require('dotenv').config();
const connectDB = require('../config/db');
const Admin = require('../models/Admin');

// Creates (or updates the password of) the default admin from .env.
(async () => {
  try {
    await connectDB();
    const email = (process.env.ADMIN_EMAIL || 'admin@kaaryo.com').toLowerCase();
    const password = process.env.ADMIN_PASSWORD || 'Admin@123';

    let admin = await Admin.findOne({ email });
    if (!admin) {
      admin = new Admin({ email, role: 'super_admin' });
      await admin.setPassword(password);
      await admin.save();
      console.log(`✅ Admin created: ${email}`);
    } else {
      await admin.setPassword(password);
      await admin.save();
      console.log(`✅ Admin password reset: ${email}`);
    }
    console.log(`   Login with email="${email}" password="${password}"`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Seed failed:', err.message);
    process.exit(1);
  }
})();
