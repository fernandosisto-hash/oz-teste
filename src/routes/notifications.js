const express = require('express');
const notificationStore = require('../store/notificationStore');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const { taskId } = req.query;
    const all = taskId
      ? await notificationStore.getByTaskId(taskId)
      : await notificationStore.getAll();
    res.json({ notifications: all, total: all.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
