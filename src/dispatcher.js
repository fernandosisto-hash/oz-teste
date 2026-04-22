const crypto = require('crypto');
const taskStore = require('./store/taskStore');
const ozClient = require('./ozClient');
const { mapOzState } = require('./ozStateMap');
const notificationService = require('./notificationService');

/**
 * Task dispatcher.
 *
 * Walks a persisted task through the execution lifecycle and records
 * execution metadata on the task record so the outcome is visible via
 * the API:
 *
 *   status:   received -> in_progress -> done | failed | cancelled
 *   fields:   runId, sessionLink, dispatchedAt, dispatchMode, runState,
 *             completedAt, finishedAt, resultSummary, lastError
 *
 * Long-running Oz runs are carried to their terminal state by the
 * separate auto-sync service (see src/syncService.js); dispatch no
 * longer has to poll to completion.
 *
 * Supported dispatch modes:
 *
 *   - "oz":      Creates a real Warp Oz cloud agent run via the REST
 *                API. This is the default when WARP_API_KEY is set. The
 *                task is marked `in_progress` as soon as the run is
 *                accepted; we then briefly poll the Oz run and transition
 *                to a terminal status if it finishes quickly. Long-running
 *                runs remain `in_progress` with `runId` + `sessionLink`
 *                stored so an operator can follow the run in Warp.
 *   - "local":   Deterministic no-op execution, immediately marked
 *                `done`. Kept as a zero-config fallback / dev mode.
 *   - "webhook": POSTs the task payload to DISPATCH_WEBHOOK_URL. A 2xx
 *                response marks the task `done`; any other response or
 *                network error marks it `failed` and stores the reason
 *                in `lastError`.
 *
 * Dispatch is awaited by the caller so the HTTP response reflects the
 * latest persisted state. No background worker/queue yet.
 */

const VALID_MODES = ['local', 'webhook', 'oz'];

function newRunId() {
  return crypto.randomUUID();
}

function defaultMode(task) {
  if (task && task.executionMode) return task.executionMode;
  return ozClient.isConfigured() ? 'oz' : 'local';
}

async function runLocal(task) {
  return {
    ok: true,
    terminal: true,
    status: 'done',
    runId: newRunId(),
    detail: `local execution of task ${task.id}`,
  };
}

async function runWebhook(task) {
  const url = process.env.DISPATCH_WEBHOOK_URL;
  if (!url) {
    return {
      ok: false,
      terminal: true,
      status: 'failed',
      runId: newRunId(),
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
      return {
        ok: false,
        terminal: true,
        status: 'failed',
        runId: newRunId(),
        error: `webhook responded with HTTP ${res.status}`,
      };
    }
    return {
      ok: true,
      terminal: true,
      status: 'done',
      runId: newRunId(),
      detail: `webhook accepted task ${task.id}`,
    };
  } catch (err) {
    return {
      ok: false,
      terminal: true,
      status: 'failed',
      runId: newRunId(),
      error: `webhook request failed: ${err.message}`,
    };
  }
}

function buildOzPrompt(task) {
  const parts = [];
  if (task.title) parts.push(task.title.trim());
  if (task.description) parts.push(String(task.description).trim());
  return parts.join('\n\n') || `Task #${task.id}`;
}

/**
 * Dispatch a task to a real Oz cloud agent run.
 *
 * Returns an execution result object with metadata to persist. The
 * return contract (`terminal`/`status`/...) mirrors the other modes so
 * the main dispatch() function can treat them uniformly.
 */
async function runOz(task) {
  let created;
  try {
    created = await ozClient.createRun({
      prompt: buildOzPrompt(task),
      name: `task-${task.id}`,
    });
  } catch (err) {
    return {
      ok: false,
      terminal: true,
      status: 'failed',
      runId: null,
      sessionLink: null,
      runState: null,
      error: `oz createRun failed: ${err.message}`,
    };
  }

  // Persist what we have now so the API caller sees in_progress with
  // runId + sessionLink even if we fail to poll later.
  taskStore.updateExecution(task.id, {
    runId: created.runId,
    sessionLink: created.sessionLink,
    runState: created.runState,
  });

  // Best-effort brief poll to catch quick completions. We intentionally
  // cap this tight so the HTTP dispatch call returns fast; anything
  // longer than this just stays in_progress and can be inspected via
  // GET /tasks/:id or the session link.
  const POLL_MAX_ATTEMPTS = 3;
  const POLL_INTERVAL_MS = 1500;
  let latest = created;

  for (let i = 0; i < POLL_MAX_ATTEMPTS; i += 1) {
    const mapped = mapOzState(latest.runState);
    if (mapped !== 'in_progress') break;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    try {
      latest = await ozClient.getRun(created.runId);
    } catch (err) {
      // Non-fatal: keep what we had and surface via lastError.
      return {
        ok: true,
        terminal: false,
        status: 'in_progress',
        runId: created.runId,
        sessionLink: created.sessionLink,
        runState: created.runState,
        pollError: `oz getRun failed: ${err.message}`,
      };
    }
  }

  const finalStatus = mapOzState(latest.runState);
  const isTerminal = finalStatus !== 'in_progress';
  return {
    ok: finalStatus !== 'failed',
    terminal: isTerminal,
    status: finalStatus,
    runId: latest.runId || created.runId,
    sessionLink: latest.sessionLink || created.sessionLink,
    runState: latest.runState || created.runState,
    error: finalStatus === 'failed' ? `oz run reported state ${latest.runState}` : null,
  };
}

async function execute(task, mode) {
  if (mode === 'webhook') return runWebhook(task);
  if (mode === 'oz') return runOz(task);
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
  const dispatchMode = mode || defaultMode(task);
  if (!VALID_MODES.includes(dispatchMode)) {
    const err = new Error(
      `invalid dispatch mode '${dispatchMode}', expected one of: ${VALID_MODES.join(', ')}`,
    );
    err.code = 'INVALID_MODE';
    throw err;
  }

  const dispatchedAt = new Date().toISOString();

  // Transition: received -> in_progress, stamping initial metadata.
  // For 'oz' the real runId/sessionLink/runState are filled in by runOz
  // after the API call succeeds.
  taskStore.updateExecution(task.id, {
    status: 'in_progress',
    dispatchedAt,
    dispatchMode,
    runId: null,
    sessionLink: null,
    runState: null,
    completedAt: null,
    finishedAt: null,
    resultSummary: null,
    lastError: null,
  });

  const result = await execute(task, dispatchMode);
  const completedAt = result.terminal ? new Date().toISOString() : null;

  const patch = {
    status: result.status,
    runId: result.runId || null,
    sessionLink: result.sessionLink || null,
    runState: result.runState || null,
    completedAt,
    finishedAt: completedAt,
    lastError: result.error || result.pollError || null,
  };

  const updated = taskStore.updateExecution(task.id, patch);

  // If dispatch resolved directly to a terminal state (local, webhook,
  // or a fast-completing Oz run), fire the terminal notification now.
  // Long-running Oz runs will be notified by the sync service instead.
  if (result.terminal) {
    await notificationService.notifyIfTerminal(updated);
    // Re-read to surface notifiedAt / notifiedStatus on the return value.
    return taskStore.getById(task.id) || updated;
  }

  return updated;
}

module.exports = {
  dispatch,
  VALID_MODES,
  // exported for testability
  _mapOzState: mapOzState,
  _defaultMode: defaultMode,
};
