/**
 * Thin client for the Warp Oz REST API.
 *
 * Only the two endpoints we actually use are wrapped here:
 *
 *   POST /api/v1/agent/run          - create a new cloud agent run
 *   GET  /api/v1/agent/runs/:runId  - fetch the current state of a run
 *
 * Authentication uses a bearer token read from WARP_API_KEY. No secrets
 * are ever hardcoded. The API base URL can be overridden via
 * WARP_API_BASE for local testing against non-production environments.
 *
 * This module keeps no state and is safe to require multiple times.
 */

const DEFAULT_API_BASE = 'https://app.warp.dev';

function apiBase() {
  return (process.env.WARP_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, '');
}

function apiKey() {
  const key = process.env.WARP_API_KEY;
  if (!key) {
    const err = new Error(
      'WARP_API_KEY is not set; cannot dispatch to Oz. Export WARP_API_KEY before running.',
    );
    err.code = 'OZ_NOT_CONFIGURED';
    throw err;
  }
  return key;
}

function headers() {
  return {
    Authorization: `Bearer ${apiKey()}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

/**
 * Normalize whatever shape the API returns into a small, stable object
 * that the rest of our app can rely on. The Warp API uses snake_case
 * (run_id, session_link, state); we expose camelCase and keep a copy of
 * the original payload for debugging.
 */
function normalizeRun(payload) {
  if (!payload || typeof payload !== 'object') {
    return { runId: null, sessionLink: null, runState: null, raw: payload };
  }
  return {
    runId: payload.run_id || payload.runId || payload.task_id || null,
    sessionLink: payload.session_link || payload.sessionLink || null,
    runState: payload.state || payload.run_state || null,
    raw: payload,
  };
}

async function readJsonSafe(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

/**
 * Create a new cloud agent run.
 *
 * @param {object} opts
 * @param {string} opts.prompt            - Required. Prompt for the agent.
 * @param {string} [opts.environmentId]   - Optional. Falls back to
 *                                          OZ_ENVIRONMENT_ID env var.
 * @param {string} [opts.name]            - Optional. Human-readable name.
 * @returns normalized run object
 */
async function createRun({ prompt, environmentId, name } = {}) {
  if (!prompt || typeof prompt !== 'string') {
    throw new Error('createRun: prompt is required');
  }

  const body = { prompt };
  const envId = environmentId || process.env.OZ_ENVIRONMENT_ID;
  if (envId) body.config = { environment_id: envId };
  if (name) body.name = name;

  const res = await fetch(`${apiBase()}/api/v1/agent/run`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
  const json = await readJsonSafe(res);
  if (!res.ok) {
    const msg = json && (json.message || json.error || json._raw);
    throw new Error(`Oz createRun failed: HTTP ${res.status} ${msg || ''}`.trim());
  }
  return normalizeRun(json);
}

/**
 * Fetch the current state of an existing run.
 */
async function getRun(runId) {
  if (!runId) throw new Error('getRun: runId is required');
  const res = await fetch(
    `${apiBase()}/api/v1/agent/runs/${encodeURIComponent(runId)}`,
    { method: 'GET', headers: headers() },
  );
  const json = await readJsonSafe(res);
  if (!res.ok) {
    const msg = json && (json.message || json.error || json._raw);
    throw new Error(`Oz getRun failed: HTTP ${res.status} ${msg || ''}`.trim());
  }
  return normalizeRun(json);
}

function isConfigured() {
  return Boolean(process.env.WARP_API_KEY);
}

module.exports = {
  createRun,
  getRun,
  isConfigured,
  // exported for tests / debugging
  _normalizeRun: normalizeRun,
};
