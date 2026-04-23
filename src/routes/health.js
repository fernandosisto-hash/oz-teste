const express = require('express');
const runtimeStatus = require('../runtimeStatus');

const router = express.Router();

router.get('/', async (_req, res, next) => {
  try {
    const payload = await runtimeStatus.build();
    const httpStatus = payload.status === 'ok' ? 200 : 503;
    res.status(httpStatus).json(payload);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
