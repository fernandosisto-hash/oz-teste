const taskStore = require('./store/taskStore');
const ozClient = require('./ozClient');
const { mapOzState } = require('./ozStateMap');

/**
 * Task auto-sync service.
 *
 * After dispatch to a real Oz run, a task may remain `in_progress` for
 * longer than the initial dispatch poll window. This module is
 * responsible for bringing such tasks to a terminal state on their own,
 * without a human in the loop.
 *
 * It is intentionally minimal: a single in-process timer walks every
 * active task that has a `runId`, asks the Oz API for the latest state
 * of the run, and persists the result. Terminal states (`done` /
 * `failed` / `cancelled`) stop further syncing for that task.
 *
 * No queue, no DB, no worker pool. Suitable as a first version.
 */

const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled']);
const ACTIVE_STATUSES = new Set(['in_progress', 'pending']);

/**
 * Best-effort extraction of a short human-readable summary from an Oz
 * run payload. Different Warp API versions have used slightly different
 * field names; we check the common ones and fall back to null.
 */
function extractResultSummary(run) {
  const raw = run && run.raw;
  if (!raw || typeof raw !== 'object') return null;
  return (
    raw.result_summary ||
    raw.resultSummary ||
    raw.summary ||
    raw.result ||
    null
  );
}

function isSyncable(task) {
  if (!task) return false;
  if (!task.runId) return false;
  if (task.dispatchMode !== 'oz') return false;
  return ACTIVE_STATUSES.has(task.status);
}

/**
 * Sync a single task against its Oz run.
 *
 * Accepts either a task id or a task object. Returns an object with the
 * updated task and an indicator of whether the sync put the task into a
 * terminal state.
 *
 * Never throws: Oz API errors are recorded on the task in `lastError`
 * and surfaced via the return value so callers (HTTP handler, auto
 * timer) can decide what to do.
 */
async function syncTask(taskOrId) {
  const task =
    typeof taskOrId === 'object' && taskOrId !== null
      ? taskOrId
      : taskStore.getById(taskOrId);

  if (!task) {
    return { ok: false, error: 'task not found', task: null };
  }

  if (TERMINAL_STATUSES.has(task.status)) {
    return { ok: true, alreadyTerminal: true, terminal: true, task };
  }

  if (!task.runId) {
    return { ok: false, error: 'task has no runId to sync', task };
  }

  if (task.dispatchMode !== 'oz') {
    return {
      ok: false,
      error: `dispatch mode '${task.dispatchMode}' cannot be synced`,
      task,
    };
  }

  let run;
  try {
    run = await ozClient.getRun(task.runId);
  } catch (err) {
    const updated = taskStore.updateExecution(task.id, {
      lastError: `sync failed: ${err.message}`,
    });
    return { ok: false, error: err.message, task: updated };
  }

  const mapped = mapOzState(run.runState);
  const isTerminal = TERMINAL_STATUSES.has(mapped);
  const now = new Date().toISOString();
  const resultSummary = extractResultSummary(run);

  const patch = {
    status: mapped,
    runState: run.runState || task.runState || null,
    sessionLink: run.sessionLink || task.sessionLink || null,
  };

  if (resultSummary) patch.resultSummary = String(resultSummary);

  if (mapped === 'failed') {
    patch.lastError =
      task.lastError || `oz run reported state ${run.runState || 'unknown'}`;
  } else if (mapped === 'done' || mapped === 'cancelled') {
    // Clear stale errors on successful/cancelled terminal resolution.
    patch.lastError = null;
  }

  if (isTerminal) {
    patch.completedAt = task.completedAt || now;
    patch.finishedAt = now;
  }

  const updated = taskStore.updateExecution(task.id, patch);
  return { ok: true, terminal: isTerminal, task: updated };
}

/**
 * Sync every active Oz task in one pass. Returns an array of per-task
 * results in the same shape as `syncTask`.
 */
async function syncInProgressTasks() {
  const candidates = taskStore.getAll().filter(isSyncable);
  const results = [];
  for (const task of candidates) {
    // Serial on purpose: avoids hammering the Oz API and keeps
    // file-store writes sequential.
    // eslint-disable-next-line no-await-in-loop
    results.push(await syncTask(task));
  }
  return results;
}

let timer = null;
let running = false;

/**
 * Start the background auto-sync loop. Safe to call multiple times;
 * subsequent calls are no-ops. Uses setTimeout chaining rather than
 * setInterval so ticks never overlap.
 */
function startAutoSync({ intervalMs = 5000, logger = console } = {}) {
  if (timer) return { started: false, reason: 'already running' };
  const interval = Math.max(500, Number(intervalMs) || 5000);

  async function tick() {
    if (running) {
      // Previous tick not finished yet; re-arm and try again later.
      timer = setTimeout(tick, interval);
      return;
    }
    running = true;
    try {
      await syncInProgressTasks();
    } catch (err) {
      if (logger && typeof logger.error === 'function') {
        logger.error(`[auto-sync] tick failed: ${err.message}`);
      }
    } finally {
      running = false;
      // Re-arm only if we haven't been stopped in the meantime.
      if (timer !== null) {
        timer = setTimeout(tick, interval);
      }
    }
  }

  timer = setTimeout(tick, interval);
  if (timer.unref) timer.unref();
  return { started: true, intervalMs: interval };
}

function stopAutoSync() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

module.exports = {
  syncTask,
  syncInProgressTasks,
  startAutoSync,
  stopAutoSync,
  // exported for tests
  _extractResultSummary: extractResultSummary,
  _isSyncable: isSyncable,
  TERMINAL_STATUSES: Array.from(TERMINAL_STATUSES),
  ACTIVE_STATUSES: Array.from(ACTIVE_STATUSES),
};
