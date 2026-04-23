const crypto = require('node:crypto');
const config = require('../config');
const logger = require('../logger');

/**
 * Minimal shared-secret API authentication.
 *
 * Behavior:
 *  - If the `API_TOKEN` environment variable is not set, the middleware
 *    logs a one-time warning and lets every request through. This
 *    keeps zero-config/dev usage friction-free. In production the
 *    missing token is instead surfaced at boot time by
 *    `config.validateForBoot()`, which aborts the process.
 *  - If `API_TOKEN` is set, every protected request must present a
 *    matching token via either:
 *        Authorization: Bearer <token>
 *    or:
 *        X-API-Token: <token>
 *    Missing credentials -> 401. Wrong credentials -> 403.
 *
 * The token comparison uses `crypto.timingSafeEqual` to avoid trivial
 * timing side-channels on a shared secret.
 */

let warned = false;

function extractToken(req) {
  const header = req.get('authorization');
  if (header && typeof header === 'string') {
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (match) return match[1].trim();
  }
  const xToken = req.get('x-api-token');
  if (xToken && typeof xToken === 'string') return xToken.trim();
  return null;
}

function tokensMatch(expected, provided) {
  if (typeof expected !== 'string' || typeof provided !== 'string') {
    return false;
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch (_) {
    return false;
  }
}

function requireAuth(req, res, next) {
  // Read via config so the env var name stays centralized, but keep
  // resolution dynamic so tests that mutate process.env across
  // requests continue to work.
  const expected = config.get('apiToken');
  if (!expected) {
    if (!warned) {
      logger.warn('auth_open', {
        detail:
          'API_TOKEN is not set — protected routes are OPEN. '
          + 'Set API_TOKEN to require a shared secret.',
      });
      warned = true;
    }
    return next();
  }

  const provided = extractToken(req);
  if (!provided) {
    return res.status(401).json({
      error: 'authentication required',
      detail:
        'Provide an API token via "Authorization: Bearer <token>" or '
        + '"X-API-Token: <token>".',
    });
  }

  if (!tokensMatch(expected, provided)) {
    return res.status(403).json({ error: 'invalid token' });
  }

  return next();
}

module.exports = {
  requireAuth,
  // Exposed for tests.
  _internal: { extractToken, tokensMatch },
};
