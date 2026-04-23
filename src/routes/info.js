const express = require('express');
const pkg = require('../../package.json');
const config = require('../config');
const orchestration = require('../orchestration');

const router = express.Router();

router.get('/', (req, res) => {
  const runtime = orchestration.runtimeSummary();
  res.json({
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    node: process.version,
    uptime: process.uptime(),
    storageBackend: config.get('storageBackend'),
    dispatch: runtime,
  });
});

module.exports = router;
