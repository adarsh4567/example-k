require('dotenv').config();
require('./src/config/validateEnv')();
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const connectDB = require('./src/config/db');
const errorHandler = require('./src/middleware/errorHandler');
const requestTiming = require('./src/middleware/requestTiming');
const { createRateLimiter } = require('./src/middleware/rateLimit');

const authRoutes = require('./src/routes/authRoutes');
const onboardingRoutes = require('./src/routes/onboardingRoutes');
const placesRoutes = require('./src/routes/placesRoutes');
const profileRoutes = require('./src/routes/profileRoutes');
const serviceRequestRoutes = require('./src/routes/serviceRequestRoutes');
const jobsRoutes = require('./src/routes/jobsRoutes');
const earningsRoutes = require('./src/routes/earningsRoutes');
const adminRoutes = require('./src/routes/adminRoutes');
const videoTaskRoutes = require('./src/routes/videoTaskRoutes');
const trialWorkerRoutes = require('./src/routes/trialWorkerRoutes');
const trialFeedbackRoutes = require('./src/routes/trialFeedbackRoutes');
const assessmentWorkerRoutes = require('./src/routes/assessmentWorkerRoutes');
const assessmentPartnerRoutes = require('./src/routes/assessmentPartnerRoutes');
const userAuthRoutes = require('./src/routes/userAuthRoutes');
const userProfileRoutes = require('./src/routes/userProfileRoutes');
const userServiceRequestRoutes = require('./src/routes/userServiceRequestRoutes');
const userTrialRoutes = require('./src/routes/userTrialRoutes');
const userWalletRoutes = require('./src/routes/userWalletRoutes');
const userCouponRoutes = require('./src/routes/userCouponRoutes');
const userReferralRoutes = require('./src/routes/userReferralRoutes');
const userAddressRoutes = require('./src/routes/userAddressRoutes');
const catalogRoutes = require('./src/routes/catalogRoutes');
const dispatchService = require('./src/services/dispatchService');
const videoJobsService = require('./src/services/videoJobsService');
const trialJobsService = require('./src/services/trialJobsService');
const assessmentJobsService = require('./src/services/assessmentJobsService');
const socket = require('./src/realtime/socket');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// Ensure the uploads directory exists (profile photos, selfies, signatures).
const uploadsDir = path.join(__dirname, 'uploads');
if (process.env.CLOUDINARY_MODE !== 'real' && !fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Core middleware
const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
app.use(cors({
  origin: allowedOrigins.length
    ? (origin, callback) => callback(null, !origin || allowedOrigins.includes(origin))
    : '*',
}));
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '100kb' }));
app.use(express.urlencoded({ extended: true, limit: process.env.FORM_BODY_LIMIT || '100kb' }));
app.use(requestTiming);
app.use(morgan(process.env.NODE_ENV === 'production' ? 'tiny' : 'dev', {
  skip: (req) => req.path === '/health/live' || req.path === '/health/ready',
}));

// Protect the small free-tier process from accidental polling loops and make
// OTP/admin credential abuse much more expensive. Socket traffic has its own
// authenticated channel and does not pass through these HTTP buckets.
app.use('/api', createRateLimiter({ windowMs: 60_000, max: 600 }));
app.use(['/api/auth', '/api/user/auth'], createRateLimiter({
  windowMs: 10 * 60_000,
  max: 20,
  key: (req) => `${req.ip}:${String(req.body?.phone || '').slice(0, 20)}`,
  message: 'Too many authentication attempts. Please try again later.',
}));
app.use('/api/admin/login', createRateLimiter({
  windowMs: 15 * 60_000,
  max: 20,
  message: 'Too many admin login attempts. Please try again later.',
}));

// Serve uploaded files statically so stored paths are viewable.
if (process.env.CLOUDINARY_MODE !== 'real') app.use('/uploads', express.static(uploadsDir));

// Health check
app.get('/', (req, res) => {
  res.json({ service: 'Kaaryo Worker Onboarding API', status: 'ok' });
});
app.get('/health/live', (req, res) => res.json({ status: 'ok', uptimeSeconds: Math.floor(process.uptime()) }));
app.get('/health/ready', (req, res) => {
  const ready = connectDB.readiness();
  res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', database: ready ? 'connected' : 'disconnected' });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/onboarding', onboardingRoutes);
app.use('/api/places', placesRoutes);
app.use('/api/profile', profileRoutes);
if (process.env.ENABLE_LEGACY_PUBLIC_REQUESTS === 'true') {
  app.use('/api/service-requests', serviceRequestRoutes);
}
app.use('/api/jobs', jobsRoutes);
app.use('/api/earnings', earningsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/worker/onboarding/video', videoTaskRoutes);
app.use('/api/worker/trial', trialWorkerRoutes);
app.use('/api/public/trial-feedback', trialFeedbackRoutes);
app.use('/api/worker/assessment', assessmentWorkerRoutes);
// Public (token-authenticated) shop-owner feedback form — the owner has no account.
app.use('/api/partner/assessment', assessmentPartnerRoutes);
// Bookable service catalog + prices. Public — the app's category picker needs it
// before login, and it's the source of truth for the keys request creation validates.
app.use('/api/services', catalogRoutes);
// Customer ("user") app — phone+OTP login, the name-only profile, and the
// book → dispatch → track → pay flow.
app.use('/api/user/auth', userAuthRoutes);
app.use('/api/user/profile', userProfileRoutes);
app.use('/api/user/service-requests', userServiceRequestRoutes);
// Discounted trial bookings (cleaning only) + the reward wallet they credit.
app.use('/api/user/trials', userTrialRoutes);
app.use('/api/user/wallet', userWalletRoutes);
// The Account tab's remaining screens: offers, the referral programme, and the
// cloud copy of the address book.
app.use('/api/user/coupons', userCouponRoutes);
app.use('/api/user/referral', userReferralRoutes);
app.use('/api/user/addresses', userAddressRoutes);

// 404 + error handling
app.use((req, res) => res.status(404).json({ success: false, message: 'Route not found' }));
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

const server = http.createServer(app);
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = 120_000;
socket.init(server); // attach the Socket.IO real-time channel to the same server

connectDB()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`\n🚀 Kaaryo API running on http://localhost:${PORT}\n`);
    });
    // Start the dispatch sweeper (expands radius / expires unaccepted requests).
    dispatchService.startSweeper();
    // Start the video-task maintenance jobs (reconcile orphaned uploads + SLA alerts).
    videoJobsService.startSweeper();
    // Start the trial-job sweeper (offer expiry + customer-feedback SLA).
    trialJobsService.startSweeper();
    // Start the shop-assessment sweeper (no-show detection + shop-feedback SLA,
    // plus deferred payouts and monthly partner-quality scoring).
    assessmentJobsService.startSweeper();
  })
  .catch((err) => {
    console.error('❌ Failed to start server:', err.message);
    process.exit(1);
  });

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; draining connections`);
  dispatchService.stopSweeper();
  videoJobsService.stopSweeper();
  trialJobsService.stopSweeper();
  assessmentJobsService.stopSweeper();

  const forceExit = setTimeout(() => process.exit(1), 10_000);
  if (forceExit.unref) forceExit.unref();
  server.close(async () => {
    await connectDB.disconnectDB().catch((err) => console.error('MongoDB shutdown error:', err.message));
    clearTimeout(forceExit);
    process.exit(0);
  });
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

module.exports = { app, server, shutdown };
