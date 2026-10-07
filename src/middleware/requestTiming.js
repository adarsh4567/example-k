const DEFAULT_SLOW_MS = 500;

const threshold = () => {
  const value = Number(process.env.SLOW_REQUEST_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_SLOW_MS;
};

// Lightweight production visibility without storing per-request data in memory.
// Server-Timing lets clients and load tests separate backend time from network
// time; only slow requests are written to logs.
module.exports = function requestTiming(req, res, next) {
  const started = process.hrtime.bigint();
  res.once('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    if (!res.headersSent) return;
    if (durationMs >= threshold()) {
      console.warn(
        `[slow-request] ${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs.toFixed(1)}ms`
      );
    }
  });

  const originalWriteHead = res.writeHead;
  res.writeHead = function timedWriteHead(...args) {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    if (!res.hasHeader('Server-Timing')) res.setHeader('Server-Timing', `app;dur=${durationMs.toFixed(1)}`);
    return originalWriteHead.apply(this, args);
  };
  next();
};
