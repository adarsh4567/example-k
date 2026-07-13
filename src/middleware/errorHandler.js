/* eslint-disable no-unused-vars */
// Central error handler. Any error passed to next(err) lands here.
module.exports = function errorHandler(err, req, res, next) {
  console.error('Error:', err.message);

  if (err.name === 'ValidationError') {
    return res.status(400).json({ success: false, message: err.message });
  }
  // Multer file-type / size errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ success: false, message: 'File too large (max 5MB)' });
  }
  if (err.message === 'ONLY_IMAGES') {
    return res.status(400).json({ success: false, message: 'Only image files are allowed' });
  }

  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error',
  });
};
