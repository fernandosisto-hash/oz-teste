const express = require('express');
const notificationStore = require('../store/notificationStore');

const router = express.Router();

/**
 * GET /notifications
 * List all terminal-state notification events that have been emitted.
 * Optional query param `taskId` filters by task.
 *
 * This is the pull-based counterpart to the webhook delivery path: any
 * consumer that prefers to poll can read the full audit trail here
 * without having to inspect individual tasks.
 */
router.get('/', (req, res) => {
  const { taskId } = req.query;
  const all = taskId
    ? notificationStore.getByTaskId(taskId)
    : notificationStore.getAll();
  res.json({ notifications: all, total: all.length });
});

module.exports = router;
