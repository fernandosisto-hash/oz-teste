const crypto = require('node:crypto');
const logger = require('../logger');

/**
 * Per-request logging + correlation id.
 *
 * - Reads `X-Request-Id` if the caller provided one; otherwise
 *   generates a UUIDv4. The value is echoed back so clients can
 *   correlate on their side too.
 * - Emits a single structured log line on response `finish` with
 *   method, path, status, content length and duration in ms.
 */
function requestLogger(req, res, next) {
  const inbound = req.get('x-request-id');
  const requestId = (inbound && inbound.trim()) || crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durNs = Number(process.hrtime.bigint() - start);
    const durationMs = Math.round(durNs / 1e6);
    const level = res.statusCode >= 500 ? 'error' : 'info';
    logger[level]('http_request', {
      requestId,
      method: req.method,
      path: req.originalUrl || req.url,
      status: res.statusCode,
      durationMs,
      contentLength: Number(res.getHeader('content-length')) || 0,
    });
  });

  next();
}

module.exports = requestLogger;
