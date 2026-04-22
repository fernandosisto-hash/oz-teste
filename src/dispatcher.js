const crypto = require('crypto');
const taskStore = require('./store/taskStore');

/**
 * Minimal first-pass task dispatcher.
 *
 * Given a persisted task, this module walks it through the execution
 * lifecycle and records metadata on the task record so the outcome is
 * visible via the API:
 *
 *   status:      received -> in_progress -> done | failed
 *   metadata:    runId, dispatchedAt, dispatchMode, completedAt, lastError
 *
 * Two dispatch modes are supported:
 *
 *   - "local":   synchronous no-op execution. The task is immediately
 *                marked as done. This is the default and requires no
 *                external configuration.
 *   - "webhook": POSTs the task payload to DISPATCH_WEBHOOK_URL (env).
 *                A 2xx response marks the task as done; anything else
 *                (including network errors) marks it as failed and
 *                stores the error message in lastError.
 *
 * Dispatch is awaited by the caller so the HTTP response reflects the
 * final state. This is intentional for a first-pass dispatcher — we do
 * not yet need background workers or queues.
 */

const VALID_MODES = ['local', 'webhook'];

function newRunId() {
  // crypto.randomUUID is available on Node >= 14.17 / 16.
  return crypto.randomUUID();
}

async function runLocal(task) {
  // Local mode is a deterministic no-op "execution". Kept as its own
  // function so later we can plug in real work (spawning a process,
  // invoking a handler registry, etc.) without touching callers.
  return { ok: true, detail: `local execution of task ${task.id}` };
}

async function runWebhook(task) {
  const url = process.env.DISPATCH_WEBHOOK_URL;
  if (!url) {
    return {
      ok: false,
      error: 'DISPATCH_WEBHOOK_URL is not configured',
    };
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task }),
    });
    if (!res.ok) {
      return { ok: false, error: `webhook responded with HTTP ${res.status}` };
    }
    return { ok: true, detail: `webhook accepted task ${task.id}` };
  } catch (err) {
    return { ok: false, error: `webhook request failed: ${err.message}` };
  }
}

async function execute(task, mode) {
  if (mode === 'webhook') return runWebhook(task);
  return runLocal(task);
}

/**
 * Dispatch a task through the chosen execution mode.
 * Returns the final persisted task record.
 *
 * Throws if the mode is invalid. Does NOT throw on execution failure —
 * failures are reflected on the task via status='failed' and lastError.
 */
async function dispatch(task, { mode } = {}) {
  const dispatchMode = mode || task.executionMode || 'local';
  if (!VALID_MODES.includes(dispatchMode)) {
    const err = new Error(
      `invalid dispatch mode '${dispatchMode}', expected one of: ${VALID_MODES.join(', ')}`,
    );
    err.code = 'INVALID_MODE';
    throw err;
  }

  const runId = newRunId();
  const dispatchedAt = new Date().toISOString();

  // Transition: received -> in_progress, stamping run metadata.
  taskStore.updateExecution(task.id, {
    status: 'in_progress',
    runId,
    dispatchedAt,
    dispatchMode,
    lastError: null,
  });

  const result = await execute(task, dispatchMode);
  const completedAt = new Date().toISOString();

  if (result.ok) {
    return taskStore.updateExecution(task.id, {
      status: 'done',
      completedAt,
    });
  }

  return taskStore.updateExecution(task.id, {
    status: 'failed',
    completedAt,
    lastError: result.error || 'unknown dispatch failure',
  });
}

module.exports = {
  dispatch,
  VALID_MODES,
};
