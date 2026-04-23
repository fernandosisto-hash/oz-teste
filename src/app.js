const express = require('express');
const config = require('./config');
const routes = require('./routes');
const requestLogger = require('./middleware/requestLogger');
const securityHeaders = require('./middleware/security');
const { notFound, errorHandler } = require('./middleware/errorHandler');

const app = express();

// Respect reverse proxy headers when explicitly configured. Leaving
// this opt-in avoids trusting spoofed headers in local development.
const trustProxy = config.get('trustProxy');
if (trustProxy) {
  app.set('trust proxy', trustProxy);
}

// Per-request correlation id + timing log.
app.use(requestLogger);

// Conservative security headers; see src/middleware/security.js.
app.use(securityHeaders);

// Body parser with an enforced size limit to blunt trivial DoS and
// accidental giant payloads. Limit is configurable via JSON_BODY_LIMIT.
app.use(express.json({ limit: config.get('jsonBodyLimit') }));

// Mount API routes
app.use('/', routes);

// 404 for anything that did not match a route.
app.use(notFound);

// Final error handler — must be last.
app.use(errorHandler);

module.exports = app;
