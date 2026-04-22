const express = require('express');

const healthRouter = require('./health');
const infoRouter = require('./info');

const router = express.Router();

router.use('/health', healthRouter);
router.use('/info', infoRouter);

module.exports = router;
