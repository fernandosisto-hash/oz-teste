const express = require('express');

const router = express.Router();

// In-memory task store
const tasks = [];
let nextId = 1;

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

  const task = {
    id: nextId++,
    title: title.trim(),
    description: description ? String(description).trim() : null,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };

  tasks.push(task);
  return res.status(201).json(task);
});

/**
 * GET /tasks
 * List all tasks.
 */
router.get('/', (req, res) => {
  res.json({ tasks, total: tasks.length });
});

/**
 * GET /tasks/:id
 * Get a single task by id.
 */
router.get('/:id', (req, res) => {
  const task = tasks.find((t) => t.id === Number(req.params.id));
  if (!task) return res.status(404).json({ error: 'task not found' });
  return res.json(task);
});

/**
 * PATCH /tasks/:id/status
 * Update the status of a task.
 * Body: { status: 'pending' | 'in_progress' | 'done' | 'cancelled' }
 */
const VALID_STATUSES = ['pending', 'in_progress', 'done', 'cancelled'];

router.patch('/:id/status', (req, res) => {
  const task = tasks.find((t) => t.id === Number(req.params.id));
  if (!task) return res.status(404).json({ error: 'task not found' });

  const { status } = req.body || {};
  if (!status || !VALID_STATUSES.includes(status)) {
    return res.status(400).json({
      error: `status must be one of: ${VALID_STATUSES.join(', ')}`,
    });
  }

  task.status = status;
  task.updatedAt = new Date().toISOString();
  return res.json(task);
});

module.exports = router;
