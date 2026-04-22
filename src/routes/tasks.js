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

module.exports = router;
