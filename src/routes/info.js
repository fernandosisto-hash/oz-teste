const express = require('express');
const pkg = require('../../package.json');
const runtimeStatus = require('../runtimeStatus');

const router = express.Router();

router.get('/', async (_req, res, next) => {
  try {
    const runtime = await runtimeStatus.build();
    res.json({
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
      node: process.version,
      uptime: process.uptime(),
      env: runtime.env,
      checks: runtime.checks,
      dispatch: {
        ...runtime.dispatch,
        validModes: ['local', 'webhook', 'oz', 'miguel'],
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
