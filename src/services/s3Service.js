/**
 * S3 access for the practical-video-task uploads (Filter 1).
 *
 * AUTH: no access keys live in code or .env. On EC2 the AWS SDK's default
 * credential provider chain picks up the instance's IAM role automatically.
 * Locally you can either export AWS_* env vars or leave S3_MODE=mock.
 *
 * MODE (mirrors the SMS_MODE / AADHAAR_MODE pattern used elsewhere):
 *   S3_MODE=mock  → no network calls; returns fake URLs and always "finds" the
 *                   object on headObject, so the full upload/confirm/review flow
 *                   can be exercised locally without S3.
 *   S3_MODE=real  → talks to the real bucket via the IAM role.
 *
 * The client is created lazily so requiring this module never crashes a
 * credential-less local process.
 */

const { v4: uuidv4 } = require('uuid');

const MODE = process.env.S3_MODE || 'mock';
const REGION = process.env.AWS_REGION || 'ap-south-1';
const BUCKET = process.env.S3_BUCKET || 'example-k-bucket';

// Signed-URL lifetimes (seconds).
const PUT_URL_TTL = Number(process.env.S3_PUT_URL_TTL_SECONDS) || 15 * 60; // 15 min
const GET_URL_TTL = Number(process.env.S3_GET_URL_TTL_SECONDS) || 60 * 60; // 1 hour

// Upload limits (bytes). Client validates too, but the server is the source of truth.
const MAX_BYTES = Number(process.env.VIDEO_MAX_BYTES) || 200 * 1024 * 1024; // 200 MB
const ALLOWED_CONTENT_TYPES = ['video/mp4', 'video/quicktime'];

let _client = null;
let _sdk = null;

// Load the AWS SDK + build the client only when real mode actually needs it.
function sdk() {
  if (_sdk) return _sdk;
  const s3 = require('@aws-sdk/client-s3');
  const presigner = require('@aws-sdk/s3-request-presigner');
  _sdk = { ...s3, ...presigner };
  return _sdk;
}

function client() {
  if (_client) return _client;
  const { S3Client } = sdk();
  _client = new S3Client({ region: REGION });
  return _client;
}

function extForContentType(contentType) {
  if (contentType === 'video/quicktime') return 'mov';
  return 'mp4';
}

// workers/{workerId}/onboarding/task{n}/{timestamp}-{uuid}.{ext}
function buildVideoKey(workerId, taskNumber, contentType) {
  const ext = extForContentType(contentType);
  const stamp = Date.now();
  return `workers/${workerId}/onboarding/task${taskNumber}/${stamp}-${uuidv4()}.${ext}`;
}

// Returns a temporary URL the phone PUTs the raw file to (bypasses our server).
async function getPresignedPutUrl({ key, contentType }) {
  if (MODE === 'mock') {
    return { url: `https://mock-s3.local/${BUCKET}/${key}?mock-put=1`, expiresIn: PUT_URL_TTL };
  }
  const { PutObjectCommand, getSignedUrl } = sdk();
  // ContentType is signed in, so the client's PUT must send a matching header.
  const command = new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType });
  const url = await getSignedUrl(client(), command, { expiresIn: PUT_URL_TTL });
  return { url, expiresIn: PUT_URL_TTL };
}

// Confirms the object exists without downloading it; returns its real size/type.
async function headObject(key) {
  if (MODE === 'mock') {
    return { exists: true, contentLength: null, contentType: null };
  }
  const { HeadObjectCommand } = sdk();
  try {
    const out = await client().send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return { exists: true, contentLength: out.ContentLength, contentType: out.ContentType };
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
      return { exists: false };
    }
    throw err;
  }
}

// Temporary streaming URL for the admin panel's HTML5 <video> player.
async function getPresignedGetUrl(key) {
  if (MODE === 'mock') {
    return `https://mock-s3.local/${BUCKET}/${key}?mock-get=1`;
  }
  const { GetObjectCommand, getSignedUrl } = sdk();
  const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(client(), command, { expiresIn: GET_URL_TTL });
}

async function deleteObject(key) {
  if (MODE === 'mock') return { deleted: true, mock: true };
  const { DeleteObjectCommand } = sdk();
  await client().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  return { deleted: true };
}

// Used by the reconciliation sweeper to find orphaned uploads under a worker.
async function listKeysUnderPrefix(prefix) {
  if (MODE === 'mock') return [];
  const { ListObjectsV2Command } = sdk();
  const out = await client().send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }));
  return (out.Contents || []).map((o) => o.Key);
}

function isAllowedContentType(ct) {
  return ALLOWED_CONTENT_TYPES.includes(ct);
}

module.exports = {
  MODE,
  BUCKET,
  REGION,
  MAX_BYTES,
  ALLOWED_CONTENT_TYPES,
  PUT_URL_TTL,
  GET_URL_TTL,
  buildVideoKey,
  getPresignedPutUrl,
  headObject,
  getPresignedGetUrl,
  deleteObject,
  listKeysUnderPrefix,
  isAllowedContentType,
  extForContentType,
};
