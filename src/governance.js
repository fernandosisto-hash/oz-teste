/**
 * Operational governance helpers shared across the API surface.
 *
 * Centralizes:
 *   - the allowed task priority vocabulary and numeric ordering
 *   - the default + maximum per-task timeout (via env)
 *   - the default retry budget (via env)
 *   - the terminal-status set and the allowed status-transition map
 *
 * These are intentionally small, pure helpers: no I/O, no state. They
 * are consumed by the dispatcher, sync service, and HTTP routes so we
 * keep a single source of truth for invalid-transition protection.
 */

const VALID_PRIORITIES = ['low', 'normal', 'high'];
const PRIORITY_RANK = { low: 0, normal: 1, high: 2 };
const DEFAULT_PRIORITY = 'normal';

const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled']);
const ACTIVE_STATUSES = new Set(['in_progress', 'pending']);

/**
 * Allowed status transitions. Any transition not listed is rejected
 * with 409 by the routes. `failed` may re-enter the lifecycle via
 * retry; `done` and `cancelled` are permanently terminal.
 */
const ALLOWED_TRANSITIONS = {
  received: new Set(['in_progress', 'cancelled', 'failed']),
  pending: new Set(['in_progress', 'cancelled', 'failed', 'received']),
  in_progress: new Set(['done', 'failed', 'cancelled']),
  failed: new Set(['received', 'in_progress']),
  done: new Set(),
  cancelled: new Set(),
};

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

function isValidTransition(from, to) {
  if (from === to) return true; // no-op tolerated at the data layer
  const allowed = ALLOWED_TRANSITIONS[from];
  return Boolean(allowed && allowed.has(to));
}

function normalizePriority(value) {
  if (value == null || value === '') return DEFAULT_PRIORITY;
  if (!VALID_PRIORITIES.includes(value)) return null;
  return value;
}

function comparePriority(a, b) {
  // High priority first; within the same bucket, older tasks first.
  const ra = PRIORITY_RANK[a.priority] ?? PRIORITY_RANK[DEFAULT_PRIORITY];
  const rb = PRIORITY_RANK[b.priority] ?? PRIORITY_RANK[DEFAULT_PRIORITY];
  if (ra !== rb) return rb - ra;
  const ca = a.createdAt || '';
  const cb = b.createdAt || '';
  if (ca < cb) return -1;
  if (ca > cb) return 1;
  return (a.id || 0) - (b.id || 0);
}

/** Hard floor/ceiling so pathological values cannot break the loop. */
const TIMEOUT_FLOOR_MS = 1000;
const TIMEOUT_CEILING_MS = 24 * 60 * 60 * 1000; // 24h

function defaultTimeoutMs() {
  const raw = Number(process.env.TASK_DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return clampTimeout(raw);
}

function clampTimeout(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(TIMEOUT_CEILING_MS, Math.max(TIMEOUT_FLOOR_MS, Math.floor(n)));
}

/**
 * Validate/normalize a timeout value from user input. Returns
 * { ok, value, error }.  `undefined` / `null` map to the default.
 */
function normalizeTimeoutMs(value) {
  if (value === undefined || value === null || value === '') {
    return { ok: true, value: defaultTimeoutMs() };
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, error: 'timeoutMs must be a positive number of milliseconds' };
  }
  if (n < TIMEOUT_FLOOR_MS) {
    return {
      ok: false,
      error: `timeoutMs must be >= ${TIMEOUT_FLOOR_MS}ms`,
    };
  }
  if (n > TIMEOUT_CEILING_MS) {
    return {
      ok: false,
      error: `timeoutMs must be <= ${TIMEOUT_CEILING_MS}ms`,
    };
  }
  return { ok: true, value: Math.floor(n) };
}

function defaultMaxRetries() {
  const raw = Number(process.env.MAX_TASK_RETRIES);
  if (!Number.isFinite(raw) || raw < 0) return 3;
  return Math.floor(raw);
}

/**
 * Decide whether a task dispatched at `dispatchedAt` with `timeoutMs`
 * has exceeded its deadline. Returns false if no timeout is configured
 * or the task was never dispatched.
 */
function hasTimedOut(task, now = Date.now()) {
  if (!task) return false;
  if (!task.timeoutMs) return false;
  if (!task.dispatchedAt) return false;
  const started = Date.parse(task.dispatchedAt);
  if (!Number.isFinite(started)) return false;
  return now - started > task.timeoutMs;
}

module.exports = {
  VALID_PRIORITIES,
  DEFAULT_PRIORITY,
  PRIORITY_RANK,
  TERMINAL_STATUSES: Array.from(TERMINAL_STATUSES),
  ACTIVE_STATUSES: Array.from(ACTIVE_STATUSES),
  ALLOWED_TRANSITIONS,
  TIMEOUT_FLOOR_MS,
  TIMEOUT_CEILING_MS,
  isTerminalStatus,
  isValidTransition,
  normalizePriority,
  comparePriority,
  defaultTimeoutMs,
  clampTimeout,
  normalizeTimeoutMs,
  defaultMaxRetries,
  hasTimedOut,
};
