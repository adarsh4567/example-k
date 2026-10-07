const { fail } = require('../utils/response');

function createRateLimiter({ windowMs, max, key = (req) => req.ip, message = 'Too many requests' }) {
  const buckets = new Map();
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [bucketKey, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(bucketKey);
    }
  }, Math.min(windowMs, 60_000));
  if (cleanup.unref) cleanup.unref();

  return function rateLimit(req, res, next) {
    const now = Date.now();
    const bucketKey = String(key(req));
    let bucket = buckets.get(bucketKey);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(bucketKey, bucket);
    }
    bucket.count += 1;

    const remaining = Math.max(0, max - bucket.count);
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count <= max) return next();

    res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
    return fail(res, message, 429);
  };
}

module.exports = { createRateLimiter };
