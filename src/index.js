/* eslint-disable no-console */
const config = require('./config');
const logger = require('./logger');

// Fail fast if the environment is misconfigured. We do this before
// requiring `./app` so boot errors do not drag in unrelated modules.
try {
  config.validateForBoot();
} catch (err) {
  // Use console.error here: logger is a JSON line, but a fatal boot
  // message should be obvious even without a log aggregator.
  console.error(`[boot] ${err.message}`);
  process.exit(1);
}

const app = require('./app');
const syncService = require('./syncService');

const PORT = config.get('port');

const server = app.listen(PORT, () => {
  logger.info('server_started', {
    port: PORT,
    nodeEnv: config.get('nodeEnv'),
    authConfigured: Boolean(config.get('apiToken')),
  });

  // Background reconciliation of in-progress Oz runs. Disabled by
  // setting AUTO_SYNC_DISABLED=true (e.g. in tests). Interval is
  // configurable via AUTO_SYNC_INTERVAL_MS.
  if (config.get('autoSyncDisabled')) {
    logger.info('auto_sync_disabled', { reason: 'AUTO_SYNC_DISABLED=true' });
    return;
  }
  const intervalMs = config.get('autoSyncIntervalMs');
  const started = syncService.startAutoSync({ intervalMs, logger });
  if (started.started) {
    logger.info('auto_sync_started', { intervalMs: started.intervalMs });
  }
});

// ---------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------
// On SIGTERM/SIGINT we stop accepting new connections, let in-flight
// requests drain, stop the auto-sync timer, and exit cleanly. A
// watchdog bounds the shutdown duration so a stuck connection cannot
// block the process forever.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutdown_started', { signal });

  syncService.stopAutoSync();

  const watchdog = setTimeout(() => {
    logger.error('shutdown_forced', { reason: 'timeout' });
    process.exit(1);
  }, 10_000);
  // Do not keep the event loop alive just for the watchdog.
  if (watchdog.unref) watchdog.unref();

  server.close((err) => {
    if (err) {
      logger.error('shutdown_close_error', { message: err.message });
      process.exit(1);
    }
    logger.info('shutdown_complete', {});
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('unhandled_rejection', {
    message: reason && reason.message,
    stack: reason && reason.stack,
  });
});
process.on('uncaughtException', (err) => {
  logger.error('uncaught_exception', { message: err.message, stack: err.stack });
  // Safer to exit: the process is in an unknown state.
  process.exit(1);
});
