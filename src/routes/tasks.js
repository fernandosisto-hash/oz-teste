const express = require('express');
const taskStore = require('../store/taskStore');
const dispatcher = require('../dispatcher');

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
