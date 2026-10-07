const path = require('path');
const multer = require('multer');

// Stores uploads on local disk under /uploads. The stored path is saved in Mongo.
// Extension comes from the client-supplied filename — allowlist it rather than
// trusting it verbatim, since it ends up in a path other tools (e.g. the admin
// panel) render into HTML/attributes.
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
function safeExt(originalname) {
  const ext = path.extname(originalname || '').toLowerCase();
  return ALLOWED_EXTENSIONS.includes(ext) ? ext : '.jpg';
}

const diskStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '..', '..', 'uploads')),
  filename: (req, file, cb) => {
    const ext = safeExt(file.originalname);
    const workerId = req.worker ? req.worker._id : 'anon';
    // Index-based suffix avoids Date.now(); still unique per field per worker.
    cb(null, `${file.fieldname}_${workerId}_${Math.round(process.hrtime()[1])}${ext}`);
  },
});
const storage = process.env.CLOUDINARY_MODE === 'real' ? multer.memoryStorage() : diskStorage;

const imageFilter = (req, file, cb) => {
  if (ALLOWED_MIME_TYPES.has(file.mimetype)) return cb(null, true);
  cb(new Error('ONLY_IMAGES'));
};

const upload = multer({
  storage,
  fileFilter: imageFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

module.exports = upload;
