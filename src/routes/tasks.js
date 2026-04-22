const express = require('express');
const taskStore = require('../store/taskStore');

const router = express.Router();

const VALID_STATUSES = ['pending', 'in_progress', 'done', 'cancelled'];

/**
 * POST /tasks
 * Intake a new task.
 * Body: { title: string, description?: string }
 */
router.post('/', (req, res) => {
  const { title, description } = req.body || {};

  if (!title || typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'title is required' });
  }

  const task = taskStore.add({
    title: title.trim(),
    description: description ? String(description).trim() : null,
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

module.exports = router;
