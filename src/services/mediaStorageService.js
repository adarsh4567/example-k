/**
 * Cloudinary media adapter.
 *
 * Controllers deal only in asset IDs and storage operations. Cloudinary-specific
 * signatures, delivery types and response shapes stay inside this module.
 */
const { v4: uuidv4 } = require('uuid');
const { v2: cloudinary } = require('cloudinary');

const MODE = process.env.CLOUDINARY_MODE || 'mock';
const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || '';
const API_KEY = process.env.CLOUDINARY_API_KEY || '';
const API_SECRET = process.env.CLOUDINARY_API_SECRET || '';
// Cloudinary validates upload-request timestamps for one hour.
const UPLOAD_SIGNATURE_TTL = 60 * 60;
const DELIVERY_URL_TTL = Number(process.env.CLOUDINARY_DELIVERY_URL_TTL_SECONDS) || 60 * 60;
const MAX_BYTES = Number(process.env.VIDEO_MAX_BYTES) || 200 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = ['video/mp4', 'video/quicktime'];
const PRIVATE_REF_PREFIX = 'cloudinary:authenticated:image:';

let configured = false;
function configure() {
  if (configured || MODE !== 'real') return;
  cloudinary.config({ cloud_name: CLOUD_NAME, api_key: API_KEY, api_secret: API_SECRET, secure: true });
  configured = true;
}

function assertConfigured() {
  if (MODE !== 'real') return;
  const missing = [
    ['CLOUDINARY_CLOUD_NAME', CLOUD_NAME],
    ['CLOUDINARY_API_KEY', API_KEY],
    ['CLOUDINARY_API_SECRET', API_SECRET],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`Missing Cloudinary configuration: ${missing.join(', ')}`);
  configure();
}

function safeSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function buildOnboardingVideoId(workerId, taskNumber) {
  return `kaaryo/private/workers/${safeSegment(workerId)}/onboarding/task${taskNumber}/${Date.now()}-${uuidv4()}`;
}

function buildSpecializationVideoId(workerId, category, subcategory) {
  return `kaaryo/private/workers/${safeSegment(workerId)}/specializations/${safeSegment(category)}/${safeSegment(subcategory)}/${Date.now()}-${uuidv4()}`;
}

/** Return the signed multipart form a client POSTs directly to Cloudinary. */
async function createDirectVideoUpload({ assetId }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signed = {
    public_id: assetId,
    timestamp,
    type: 'authenticated',
    overwrite: false,
  };

  if (MODE === 'mock') {
    return {
      url: 'https://mock-cloudinary.local/video/upload',
      method: 'POST',
      fields: { ...signed, api_key: 'mock', signature: 'mock' },
      expiresIn: UPLOAD_SIGNATURE_TTL,
    };
  }

  assertConfigured();
  return {
    url: `https://api.cloudinary.com/v1_1/${encodeURIComponent(CLOUD_NAME)}/video/upload`,
    method: 'POST',
    fields: {
      ...signed,
      api_key: API_KEY,
      signature: cloudinary.utils.api_sign_request(signed, API_SECRET),
    },
    expiresIn: UPLOAD_SIGNATURE_TTL,
  };
}

function contentTypeFor(format, resourceType) {
  if (resourceType === 'video') {
    if (format === 'mov') return 'video/quicktime';
    if (format) return `video/${format}`;
  }
  return format ? `image/${format === 'jpg' ? 'jpeg' : format}` : null;
}

function formatForContentType(contentType) {
  return ({
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
  })[contentType] || '';
}

async function inspectAsset(assetId, resourceType = 'video') {
  if (MODE === 'mock') return { exists: true, contentLength: null, contentType: null, durationSeconds: null };
  assertConfigured();
  try {
    const asset = await cloudinary.api.resource(assetId, {
      resource_type: resourceType,
      type: 'authenticated',
    });
    return {
      exists: true,
      contentLength: asset.bytes ?? null,
      contentType: contentTypeFor(asset.format, resourceType),
      format: asset.format || null,
      durationSeconds: Number.isFinite(asset.duration) ? asset.duration : null,
    };
  } catch (err) {
    if (err?.http_code === 404 || err?.error?.http_code === 404) return { exists: false };
    throw err;
  }
}

/** Authenticated Cloudinary download URL with a hard expiry. */
async function getDeliveryUrl(assetId, resourceType = 'video', format = '') {
  if (MODE === 'mock') return `https://mock-cloudinary.local/${resourceType}/${encodeURIComponent(assetId)}`;
  assertConfigured();
  if (!format) throw new Error('A file format is required for an authenticated delivery URL');
  return cloudinary.utils.private_download_url(assetId, format, {
    resource_type: resourceType,
    type: 'authenticated',
    expires_at: Math.floor(Date.now() / 1000) + DELIVERY_URL_TTL,
    attachment: false,
  });
}

function uploadBuffer(file, options) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
    stream.end(file.buffer);
  });
}

async function storeImage({ workerId, kind, file, publicAsset = false }) {
  if (MODE === 'mock') {
    if (!file.filename) throw new Error('Mock image storage requires disk-backed upload middleware');
    return `/uploads/${file.filename}`;
  }
  if (!file.buffer) throw new Error('Image upload buffer is missing');
  assertConfigured();

  const visibility = publicAsset ? 'public' : 'private';
  const result = await uploadBuffer(file, {
    resource_type: 'image',
    type: publicAsset ? 'upload' : 'authenticated',
    folder: `kaaryo/${visibility}/workers/${safeSegment(workerId)}/${safeSegment(kind)}`,
    unique_filename: true,
    overwrite: false,
    transformation: [{ width: 1600, height: 1600, crop: 'limit', quality: 'auto:good' }],
  });
  return publicAsset ? result.secure_url : `${PRIVATE_REF_PREFIX}${result.format}:${result.public_id}`;
}

async function resolveStoredUrl(ref) {
  if (!ref) return null;
  if (!ref.startsWith(PRIVATE_REF_PREFIX)) return ref;
  const encoded = ref.slice(PRIVATE_REF_PREFIX.length);
  const separator = encoded.indexOf(':');
  if (separator < 1) throw new Error('Invalid private Cloudinary image reference');
  return getDeliveryUrl(encoded.slice(separator + 1), 'image', encoded.slice(0, separator));
}

async function deleteAsset(assetId, resourceType = 'video') {
  if (MODE === 'mock') return { deleted: true, mock: true };
  assertConfigured();
  const result = await cloudinary.uploader.destroy(assetId, {
    resource_type: resourceType,
    type: 'authenticated',
    invalidate: true,
  });
  return { deleted: ['ok', 'not found'].includes(result.result), result: result.result };
}

function isAllowedContentType(contentType) {
  return ALLOWED_CONTENT_TYPES.includes(contentType);
}

module.exports = {
  MODE,
  MAX_BYTES,
  ALLOWED_CONTENT_TYPES,
  UPLOAD_SIGNATURE_TTL,
  DELIVERY_URL_TTL,
  buildOnboardingVideoId,
  buildSpecializationVideoId,
  createDirectVideoUpload,
  inspectAsset,
  getDeliveryUrl,
  storeImage,
  resolveStoredUrl,
  deleteAsset,
  isAllowedContentType,
  formatForContentType,
  assertConfigured,
};
