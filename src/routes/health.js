const express = require('express');
const config = require('../config');
const orchestration = require('../orchestration');

const router = express.Router();

router.get('/', (req, res) => {
  const runtime = orchestration.runtimeSummary();
  res.json({
    status: 'ok',
    storageBackend: config.get('storageBackend'),
    dispatch: {
      defaultExecutionMode: runtime.defaultExecutionMode,
      resolvedDefaultMode: runtime.resolvedDefaultMode,
      miguel: runtime.miguel,
    },
  });
});

module.exports = router;
