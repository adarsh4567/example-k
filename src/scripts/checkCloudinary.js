require('dotenv').config();
const media = require('../services/mediaStorageService');

async function main() {
  if (media.MODE !== 'real') {
    throw new Error('Set CLOUDINARY_MODE=real before running this connectivity check');
  }
  media.assertConfigured();
  const { v2: cloudinary } = require('cloudinary');
  const result = await cloudinary.api.ping();
  if (result.status !== 'ok') throw new Error(`Cloudinary ping failed: ${JSON.stringify(result)}`);
  console.log('Cloudinary credentials are valid.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
