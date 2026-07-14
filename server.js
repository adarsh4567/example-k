require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const connectDB = require('./src/config/db');
const errorHandler = require('./src/middleware/errorHandler');

const authRoutes = require('./src/routes/authRoutes');
const onboardingRoutes = require('./src/routes/onboardingRoutes');
const placesRoutes = require('./src/routes/placesRoutes');
const profileRoutes = require('./src/routes/profileRoutes');
const adminRoutes = require('./src/routes/adminRoutes');

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
app.use('/api/admin', adminRoutes);

// 404 + error handling
app.use((req, res) => res.status(404).json({ success: false, message: 'Route not found' }));
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

connectDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n🚀 Kaaryo API running on http://localhost:${PORT}\n`);
    });
  })
  .catch((err) => {
    console.error('❌ Failed to start server:', err.message);
    process.exit(1);
  });
