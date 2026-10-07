/* eslint-disable no-unused-vars */
// Central error handler. Any error passed to next(err) lands here.
module.exports = function errorHandler(err, req, res, next) {
  console.error('Error:', err.message);

  if (err.name === 'ValidationError') {
    return res.status(400).json({ success: false, message: err.message });
  }
  if (err.name === 'CastError') {
    return res.status(400).json({ success: false, message: 'Invalid identifier or value' });
  }
  if (err.code === 11000) {
    return res.status(409).json({ success: false, message: 'A record with those unique details already exists' });
  }
  // Multer file-type / size errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ success: false, message: 'File too large (max 5MB)' });
  }
  if (err.message === 'ONLY_IMAGES') {
    return res.status(400).json({ success: false, message: 'Only image files are allowed' });
  }

  const status = err.status || 500;
  res.status(status).json({
    success: false,
    message: status >= 500 && process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message || 'Internal server error',
  });
};
