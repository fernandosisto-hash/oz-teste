/**
 * Minimal security headers.
 *
 * Intentionally zero-dependency. Covers the low-cost defaults that are
 * almost always appropriate for a JSON API:
 *
 *   - X-Content-Type-Options: nosniff
 *   - X-Frame-Options: DENY
 *   - Referrer-Policy: no-referrer
 *   - X-DNS-Prefetch-Control: off
 *   - X-Powered-By removed (do not advertise Express)
 *
 * Heavier hardening (CSP, HSTS, CORS policy, rate limiting) is
 * deliberately deferred to the next PR where we also introduce a
 * reverse proxy / deployment story and can set those intentionally.
 */
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.removeHeader('X-Powered-By');
  next();
}

module.exports = securityHeaders;
