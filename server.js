require('dotenv').config();
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const connectDB = require('./src/config/db');
const errorHandler = require('./src/middleware/errorHandler');

const authRoutes = require('./src/routes/authRoutes');
const onboardingRoutes = require('./src/routes/onboardingRoutes');
const placesRoutes = require('./src/routes/placesRoutes');
const profileRoutes = require('./src/routes/profileRoutes');
const serviceRequestRoutes = require('./src/routes/serviceRequestRoutes');
const jobsRoutes = require('./src/routes/jobsRoutes');
const earningsRoutes = require('./src/routes/earningsRoutes');
const adminRoutes = require('./src/routes/adminRoutes');
const videoTaskRoutes = require('./src/routes/videoTaskRoutes');
const dispatchService = require('./src/services/dispatchService');
const videoJobsService = require('./src/services/videoJobsService');
const socket = require('./src/realtime/socket');

const app = express();

// Ensure the uploads directory exists (profile photos, selfies, signatures).
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Core middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

// Serve uploaded files statically so stored paths are viewable.
app.use('/uploads', express.static(uploadsDir));

// Health check
app.get('/', (req, res) => {
  res.json({ service: 'Kaaryo Worker Onboarding API', status: 'ok' });
});

// Admin panel — single static file, served explicitly (not the whole project root).
app.get(['/admin', '/admin.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/onboarding', onboardingRoutes);
app.use('/api/places', placesRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/service-requests', serviceRequestRoutes);
app.use('/api/jobs', jobsRoutes);
app.use('/api/earnings', earningsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/worker/onboarding/video', videoTaskRoutes);

// 404 + error handling
app.use((req, res) => res.status(404).json({ success: false, message: 'Route not found' }));
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

const server = http.createServer(app);
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
  })
  .catch((err) => {
    console.error('❌ Failed to start server:', err.message);
    process.exit(1);
  });
