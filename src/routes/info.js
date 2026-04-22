const express = require('express');
const pkg = require('../../package.json');

const router = express.Router();

router.get('/', (req, res) => {
  res.json({
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    node: process.version,
    uptime: process.uptime(),
  });
});

module.exports = router;
