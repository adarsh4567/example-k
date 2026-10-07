process.env.CLOUDINARY_MODE = 'mock';
const assert = require('assert');
const media = require('../services/mediaStorageService');

async function main() {
  assert.equal(media.MODE, 'mock', 'media unit test must run without real Cloudinary writes');
  const workerId = '507f1f77bcf86cd799439011';
  const onboardingId = media.buildOnboardingVideoId(workerId, 1);
  assert(onboardingId.startsWith(`kaaryo/private/workers/${workerId}/onboarding/task1/`));

  const specializationId = media.buildSpecializationVideoId(workerId, 'home cleaning', 'deep/clean');
  assert(specializationId.startsWith(`kaaryo/private/workers/${workerId}/specializations/home_cleaning/deep_clean/`));

  const upload = await media.createDirectVideoUpload({ assetId: onboardingId });
  assert.equal(upload.method, 'POST');
  assert.equal(upload.fields.public_id, onboardingId);
  assert.equal(upload.fields.type, 'authenticated');
  assert.equal(media.isAllowedContentType('video/mp4'), true);
  assert.equal(media.isAllowedContentType('application/octet-stream'), false);

  const asset = await media.inspectAsset(onboardingId);
  assert.equal(asset.exists, true);
  const delivery = await media.getDeliveryUrl(onboardingId, 'video', 'mp4');
  assert(delivery.includes(encodeURIComponent(onboardingId)));
  console.log('Cloudinary media adapter: mock contract passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
