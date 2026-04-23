const express = require('express');
const taskStore = require('../store/taskStore');
const dispatcher = require('../dispatcher');
const syncService = require('../syncService');
const notificationStore = require('../store/notificationStore');
const notificationService = require('../notificationService');
const governance = require('../governance');
const validation = require('../validation');

const router = express.Router();

// 'pending' is kept for backwards compatibility with records created
// before the dispatch feature existed. New tasks default to 'received'.
const VALID_STATUSES = [
  'pending',
  'received',
  'in_progress',
  'done',
  'failed',
  'cancelled',
];

/**
 * POST /tasks
 * Intake a new task.
 * Body: {
 *   title: string,
 *   description?: string,
 *   executionMode?: 'local' | 'webhook'
 * }
 */
router.post('/', async (req, res, next) => {
  try {
  const {
    title,
    description,
    executionMode,
    priority,
    timeoutMs,
    maxRetries,
  } = req.body || {};

  // Consistent validation via shared helpers. Each returns
  // { ok, value?, error? } and the 400 response shape is stable.
  const titleCheck = validation.asNonEmptyString('title', title);
  if (!titleCheck.ok) return validation.badRequest(res, titleCheck.error);

  const modeCheck = validation.asEnum(
    'executionMode',
    executionMode,
    dispatcher.VALID_MODES,
    { optional: true },
  );
  if (!modeCheck.ok) return validation.badRequest(res, modeCheck.error);

  const normalizedPriority = governance.normalizePriority(priority);
  if (normalizedPriority === null) {
    return validation.badRequest(
      res,
      `priority must be one of: ${governance.VALID_PRIORITIES.join(', ')}`,
    );
  }

  const timeoutCheck = governance.normalizeTimeoutMs(timeoutMs);
  if (!timeoutCheck.ok) return validation.badRequest(res, timeoutCheck.error);

  const retriesCheck = validation.asNonNegativeInt('maxRetries', maxRetries);
  if (!retriesCheck.ok) return validation.badRequest(res, retriesCheck.error);

  const task = await taskStore.add({
    title: titleCheck.value,
    description: description ? String(description).trim() : null,
    executionMode,
    priority: normalizedPriority,
    timeoutMs: timeoutCheck.value,
    maxRetries: retriesCheck.value,
  });
  return res.status(201).json(task);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /tasks
 * List all tasks.
 */
router.get('/', async (req, res, next) => {
  try {
  const tasks = await taskStore.getAll();
  res.json({ tasks, total: tasks.length });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /tasks/:id
 * Get a single task by id.
 */
router.get('/:id', async (req, res, next) => {
  try {
  const task = await taskStore.getById(req.params.id);
  if (!task) return res.status(404).json({ error: 'task not found' });
  return res.json(task);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /tasks/:id/notifications
 * List the terminal-state notification events that have been emitted
 * for this task (usually zero or one; more if the task legitimately
 * re-enters a different terminal state).
 */
router.get('/:id/notifications', async (req, res, next) => {
  try {
  const task = await taskStore.getById(req.params.id);
  if (!task) return res.status(404).json({ error: 'task not found' });
  const events = await notificationStore.getByTaskId(req.params.id);
  return res.json({ notifications: events, total: events.length });
  } catch (err) {
    return next(err);
  }
});

/**
 * PATCH /tasks/:id/status
 * Update the status of a task.
 * Body: { status: 'pending' | 'in_progress' | 'done' | 'cancelled' }
 */
router.patch('/:id/status', async (req, res, next) => {
  try {
  const { status } = req.body || {};
  if (!status || !VALID_STATUSES.includes(status)) {
    return res.status(400).json({
      error: `status must be one of: ${VALID_STATUSES.join(', ')}`,
    });
  }

  const existing = await taskStore.getById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'task not found' });

  if (!governance.isValidTransition(existing.status, status)) {
    return res.status(409).json({
      error: `invalid transition: '${existing.status}' -> '${status}'`,
    });
  }

  const task = await taskStore.updateStatus(req.params.id, status);
  return res.json(task);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /tasks/:id/dispatch
 * Dispatch a task through the orchestrator. The request resolves once
 * the task has reached a terminal state (`done` or `failed`). The
 * resulting task record includes execution metadata: runId,
 * dispatchedAt, dispatchMode, completedAt, and (on failure) lastError.
 *
 * Body (optional): { mode?: 'local' | 'webhook' }
 * If omitted, the task's own executionMode is used (default 'local').
 *
 * Tasks already in a terminal or active state cannot be re-dispatched
 * without first resetting their status.
 */
/**
 * POST /tasks/sync
 * Reconcile every in-progress Oz-backed task in one pass. Useful to
 * manually kick the loop without waiting for the next auto-sync tick.
 * Returns per-task sync results.
 */
router.post('/sync', async (req, res, next) => {
  try {
    const results = await syncService.syncInProgressTasks();
    return res.json({ synced: results.length, results });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /tasks/:id/sync
 * Sync a single task against its Oz run and return the updated task.
 * No-op (with 200) if the task is already in a terminal state. Returns
 * 409 for tasks that cannot be synced (missing runId or non-oz mode).
 */
router.post('/:id/sync', async (req, res, next) => {
  const task = await taskStore.getById(req.params.id);
  if (!task) return res.status(404).json({ error: 'task not found' });

  try {
    const result = await syncService.syncTask(task);
    if (!result.ok) {
      return res.status(409).json({
        error: result.error,
        task: result.task || task,
      });
    }
    return res.json(result.task);
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/dispatch', async (req, res, next) => {
  const task = await taskStore.getById(req.params.id);
  if (!task) return res.status(404).json({ error: 'task not found' });

  const dispatchable = ['received', 'pending', 'failed'];
  if (!dispatchable.includes(task.status)) {
    return res.status(409).json({
      error: `task in status '${task.status}' cannot be dispatched`,
    });
  }

  const { mode } = req.body || {};
  try {
    const updated = await dispatcher.dispatch(task, { mode });
    return res.status(202).json(updated);
  } catch (err) {
    if (err.code === 'INVALID_MODE') {
      return res.status(400).json({ error: err.message });
    }
    return next(err);
  }
});

/**
 * POST /tasks/:id/cancel
 * Locally cancel a task. Valid from `received`, `pending`, or
 * `in_progress`. Tasks already in a terminal state (`done`, `failed`,
 * `cancelled`) are rejected with 409 so duplicate cancels surface
 * clearly to the caller.
 *
 * Note: this is a LOCAL cancellation only. If the task was dispatched
 * to a remote Oz run, the underlying run is NOT aborted — we just
 * mark the task `cancelled` in our store, fire a terminal
 * notification, and stop syncing it. The operator can follow
 * `sessionLink` to inspect the remote run in Warp.
 */
router.post('/:id/cancel', async (req, res, next) => {
  const task = await taskStore.getById(req.params.id);
  if (!task) return res.status(404).json({ error: 'task not found' });

  if (governance.isTerminalStatus(task.status)) {
    return res.status(409).json({
      error: `task in status '${task.status}' cannot be cancelled`,
    });
  }

  const now = new Date().toISOString();
  const updated = await taskStore.updateExecution(task.id, {
    status: 'cancelled',
    cancelledAt: now,
    completedAt: task.completedAt || now,
    finishedAt: now,
  });

  try {
    await notificationService.notifyIfTerminal(updated);
  } catch (err) {
    return next(err);
  }

  const finalTask = (await taskStore.getById(task.id)) || updated;
  return res.status(200).json(finalTask);
});

/**
 * POST /tasks/:id/retry
 * Re-dispatch a previously-failed task. Only valid from the `failed`
 * status. Enforces a per-task retry budget: the effective limit is
 * the task's own `maxRetries` if set, otherwise the global default
 * `MAX_TASK_RETRIES` (default 3).
 *
 * Body (optional): { mode?: 'local' | 'webhook' | 'oz' }
 * If omitted, the task's own executionMode is used.
 *
 * Increments `retryCount` before dispatching and clears the
 * previous-cycle notification stamp so a new terminal notification is
 * emitted when the retry completes.
 */
router.post('/:id/retry', async (req, res, next) => {
  const task = await taskStore.getById(req.params.id);
  if (!task) return res.status(404).json({ error: 'task not found' });

  if (task.status !== 'failed') {
    return res.status(409).json({
      error: `task in status '${task.status}' cannot be retried (must be 'failed')`,
    });
  }

  const limit = Number.isFinite(task.maxRetries) && task.maxRetries !== null
    ? task.maxRetries
    : governance.defaultMaxRetries();
  const used = Number.isFinite(task.retryCount) ? task.retryCount : 0;
  if (used >= limit) {
    return res.status(409).json({
      error: `retry budget exhausted (${used}/${limit})`,
      retryCount: used,
      maxRetries: limit,
    });
  }

  // Reset per-cycle state so a fresh lifecycle can run. The
  // notification stamp is cleared so the next terminal state fires
  // a new event; `lastError` and `timedOut` are cleared to avoid
  // stale metadata bleeding through.
  const reset = await taskStore.updateExecution(task.id, {
    status: 'received',
    retryCount: used + 1,
    lastError: null,
    timedOut: false,
    notifiedAt: null,
    notifiedStatus: null,
    completedAt: null,
    finishedAt: null,
  });

  const { mode } = req.body || {};
  try {
    const updated = await dispatcher.dispatch(reset, { mode });
    return res.status(202).json(updated);
  } catch (err) {
    if (err.code === 'INVALID_MODE') {
      return res.status(400).json({ error: err.message });
    }
    return next(err);
  }
});

module.exports = router;
