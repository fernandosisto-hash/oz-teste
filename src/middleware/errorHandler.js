const logger = require('../logger');
const config = require('../config');
const { ValidationError } = require('../validation');

/**
 * 404 handler for paths that did not match any route.
 * Kept tiny and backwards-compatible with the existing route-level
 * `{ error: 'not found' }` responses so clients only ever see one shape.
 */
function notFound(req, res, _next) {
  res.status(404).json({
    error: 'not found',
    path: req.originalUrl || req.url,
  });
}

function isJsonParseError(err) {
  return (
    err
    && err.type === 'entity.parse.failed'
    // express.json reports the raw SyntaxError with a status of 400
    || (err && err.name === 'SyntaxError' && 'body' in err)
  );
}

function isBodyTooLargeError(err) {
  return err && err.type === 'entity.too.large';
}

/**
 * Final Express error middleware.
 *
 * Normalizes every unhandled error to:
 *   { error: <string>, code?: <string>, details?: <object> }
 *
 * 5xx responses never leak the raw error message or stack — they
 * surface as `internal error`. The full error is logged with the
 * request id (if the requestLogger ran earlier) for server-side
 * correlation.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  let status = Number(err.status || err.statusCode) || 500;
  let code = err.code || null;
  let message = err.message || 'error';
  let details = err.details || null;

  if (err instanceof ValidationError) {
    status = 400;
    code = code || 'VALIDATION_ERROR';
    details = details || err.details || null;
  } else if (isJsonParseError(err)) {
    status = 400;
    code = 'INVALID_JSON';
    message = 'invalid JSON body';
  } else if (isBodyTooLargeError(err)) {
    status = 413;
    code = 'PAYLOAD_TOO_LARGE';
    message = 'request body too large';
  }

  logger.error('unhandled_error', {
    requestId: req.requestId,
    method: req.method,
    path: req.originalUrl || req.url,
    status,
    code,
    errorMessage: err.message,
    // Stack is only logged (never returned). Suppress in prod if
    // you prefer via LOG_LEVEL, but keep machine-parseable for ops.
    stack: err.stack,
  });

  const body = {
    error: status >= 500 ? 'internal error' : message,
  };
  if (code) body.code = code;
  if (details) body.details = details;
  if (status >= 500 && !config.isProduction() && err.message) {
    // In non-prod, surface the message to speed up debugging without
    // changing the shape (`error` remains the canonical field).
    body.debug = err.message;
  }

  res.status(status).json(body);
}

module.exports = { notFound, errorHandler };
