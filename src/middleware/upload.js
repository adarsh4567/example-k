const path = require('path');
const multer = require('multer');

// Stores uploads on local disk under /uploads. The stored path is saved in Mongo.
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '..', '..', 'uploads')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    const workerId = req.worker ? req.worker._id : 'anon';
    // Index-based suffix avoids Date.now(); still unique per field per worker.
    cb(null, `${file.fieldname}_${workerId}_${Math.round(process.hrtime()[1])}${ext}`);
  },
});

const imageFilter = (req, file, cb) => {
  if (file.mimetype.startsWith('image/')) return cb(null, true);
  cb(new Error('ONLY_IMAGES'));
};

const upload = multer({
  storage,
  fileFilter: imageFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

module.exports = upload;
