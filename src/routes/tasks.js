const express = require('express');
const taskStore = require('../store/taskStore');
const dispatcher = require('../dispatcher');
const syncService = require('../syncService');
const notificationStore = require('../store/notificationStore');

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
router.post('/', (req, res) => {
  const { title, description, executionMode } = req.body || {};

  if (!title || typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'title is required' });
  }

  if (executionMode && !dispatcher.VALID_MODES.includes(executionMode)) {
    return res.status(400).json({
      error: `executionMode must be one of: ${dispatcher.VALID_MODES.join(', ')}`,
    });
  }

  const task = taskStore.add({
    title: title.trim(),
    description: description ? String(description).trim() : null,
    executionMode,
  });
  return res.status(201).json(task);
});

/**
 * GET /tasks
 * List all tasks.
 */
router.get('/', (req, res) => {
  const tasks = taskStore.getAll();
  res.json({ tasks, total: tasks.length });
});

/**
 * GET /tasks/:id
 * Get a single task by id.
 */
router.get('/:id', (req, res) => {
  const task = taskStore.getById(req.params.id);
  if (!task) return res.status(404).json({ error: 'task not found' });
  return res.json(task);
});

/**
 * GET /tasks/:id/notifications
 * List the terminal-state notification events that have been emitted
 * for this task (usually zero or one; more if the task legitimately
 * re-enters a different terminal state).
 */
router.get('/:id/notifications', (req, res) => {
  const task = taskStore.getById(req.params.id);
  if (!task) return res.status(404).json({ error: 'task not found' });
  const events = notificationStore.getByTaskId(req.params.id);
  return res.json({ notifications: events, total: events.length });
});

/**
 * PATCH /tasks/:id/status
 * Update the status of a task.
 * Body: { status: 'pending' | 'in_progress' | 'done' | 'cancelled' }
 */
router.patch('/:id/status', (req, res) => {
  const { status } = req.body || {};
  if (!status || !VALID_STATUSES.includes(status)) {
    return res.status(400).json({
      error: `status must be one of: ${VALID_STATUSES.join(', ')}`,
    });
  }

  const task = taskStore.updateStatus(req.params.id, status);
  if (!task) return res.status(404).json({ error: 'task not found' });
  return res.json(task);
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
  const task = taskStore.getById(req.params.id);
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
  const task = taskStore.getById(req.params.id);
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

module.exports = router;
