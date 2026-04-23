/**
 * Small validation toolkit shared across HTTP routes.
 *
 * The goal is to make request validation consistent without reaching
 * for a schema library yet. Each helper returns { ok, value?, error? }
 * so call sites can short-circuit with a 400 response, or they can
 * throw `ValidationError` which the global error handler converts
 * into a 400.
 */

class ValidationError extends Error {
  constructor(message, { code = 'VALIDATION_ERROR', details = null } = {}) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
    this.code = code;
    this.details = details;
    this.expose = true;
  }
}

function asNonEmptyString(field, value) {
  if (typeof value !== 'string' || !value.trim()) {
    return { ok: false, error: `${field} is required` };
  }
  return { ok: true, value: value.trim() };
}

function asEnum(field, value, allowed, { optional = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return { ok: true, value: undefined };
    return {
      ok: false,
      error: `${field} must be one of: ${allowed.join(', ')}`,
    };
  }
  if (!allowed.includes(value)) {
    return {
      ok: false,
      error: `${field} must be one of: ${allowed.join(', ')}`,
    };
  }
  return { ok: true, value };
}

function asNonNegativeInt(field, value, { optional = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return { ok: true, value: null };
    return { ok: false, error: `${field} is required` };
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    return {
      ok: false,
      error: `${field} must be a non-negative integer`,
    };
  }
  return { ok: true, value: Math.floor(n) };
}

/**
 * Convenience: send a 400 with a consistent shape. Kept for routes
 * that prefer early-return over throwing ValidationError.
 */
function badRequest(res, error, { code, details } = {}) {
  const body = { error };
  if (code) body.code = code;
  if (details) body.details = details;
  return res.status(400).json(body);
}

module.exports = {
  ValidationError,
  asNonEmptyString,
  asEnum,
  asNonNegativeInt,
  badRequest,
};
