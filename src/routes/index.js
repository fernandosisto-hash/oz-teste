const express = require('express');

const healthRouter = require('./health');
const infoRouter = require('./info');
const tasksRouter = require('./tasks');
const notificationsRouter = require('./notifications');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Public routes: liveness + basic introspection stay open so operators
// and uptime probes can reach them without a shared secret.
router.use('/health', healthRouter);
router.use('/info', infoRouter);

// Protected routes: task orchestration + notification retrieval require
// the shared API token when API_TOKEN is configured.
router.use('/tasks', requireAuth, tasksRouter);
router.use('/notifications', requireAuth, notificationsRouter);

module.exports = router;
