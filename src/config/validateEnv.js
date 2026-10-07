function requireValue(name) {
  if (!process.env[name]) throw new Error(`${name} is required`);
}

module.exports = function validateEnv() {
  ['MONGODB_URI', 'JWT_SECRET', 'ADMIN_JWT_SECRET'].forEach(requireValue);

  if (process.env.JWT_SECRET === process.env.ADMIN_JWT_SECRET) {
    throw new Error('JWT_SECRET and ADMIN_JWT_SECRET must be different');
  }

  if (process.env.NODE_ENV !== 'production') return;
  if (process.env.JWT_SECRET.length < 32 || process.env.ADMIN_JWT_SECRET.length < 32) {
    throw new Error('JWT secrets must each be at least 32 characters in production');
  }

  if (process.env.ALLOW_INSECURE_PRODUCTION === 'true') return;
  const insecure = [];
  if ((process.env.SMS_MODE || 'mock') === 'mock') insecure.push('SMS_MODE');
  if ((process.env.PAYMENT_MODE || 'mock') === 'mock') insecure.push('PAYMENT_MODE');
  if ((process.env.CLOUDINARY_MODE || 'mock') !== 'real') insecure.push('CLOUDINARY_MODE');
  if (process.env.CLOUDINARY_MODE === 'real') {
    ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']
      .filter((name) => !process.env[name])
      .forEach((name) => insecure.push(name));
  }
  if (insecure.length) {
    throw new Error(
      `${insecure.join(', ')} cannot use mock mode in production. ` +
      'Configure real providers or set ALLOW_INSECURE_PRODUCTION=true only for a non-production demo.'
    );
  }
};
