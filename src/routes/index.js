const express = require('express');

const healthRouter = require('./health');
const infoRouter = require('./info');
const tasksRouter = require('./tasks');
const notificationsRouter = require('./notifications');

const router = express.Router();

router.use('/health', healthRouter);
router.use('/info', infoRouter);
router.use('/tasks', tasksRouter);
router.use('/notifications', notificationsRouter);

module.exports = router;
