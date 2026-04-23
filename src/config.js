/**
 * Centralized configuration.
 *
 * All access to `process.env` for operational concerns should funnel
 * through here. Reads are intentionally performed on demand (not
 * memoized) so tests that mutate `process.env` between requires and
 * requests continue to see the latest value.
 *
 * `validateForBoot()` is called from `src/index.js` at process start
 * and throws if any environment-dependent invariants are violated
 * (e.g. running in production without API_TOKEN). It is NOT called
 * from `src/app.js` on purpose: in-process tests that require the
 * app directly should not need to emulate a full production env.
 */

const PROD_ENV = 'production';
const VALID_EXECUTION_MODES = ['local', 'webhook', 'oz', 'miguel'];
const VALID_MIGUEL_TARGETS = ['local', 'webhook', 'oz'];

function nodeEnv() {
  return process.env.NODE_ENV || 'development';
}

function isProduction() {
  return nodeEnv() === PROD_ENV;
}

function parseIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function parseBoolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  return String(raw).toLowerCase() === 'true';
}

function parseCsvEnv(name, fallback = []) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  return String(raw)
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function defaultExecutionMode() {
  const explicit = (process.env.DEFAULT_EXECUTION_MODE || '').trim().toLowerCase();
  if (VALID_EXECUTION_MODES.includes(explicit)) return explicit;
  return process.env.WARP_API_KEY ? 'oz' : 'local';
}

function miguelDispatchOrder() {
  const parsed = parseCsvEnv('MIGUEL_DISPATCH_ORDER', ['oz', 'webhook', 'local']);
  const deduped = [];
  for (const mode of parsed) {
    if (!VALID_MIGUEL_TARGETS.includes(mode)) continue;
    if (deduped.includes(mode)) continue;
    deduped.push(mode);
  }
  return deduped.length > 0 ? deduped : ['oz', 'webhook', 'local'];
}

/**
 * Typed accessor for a single config key. Centralizing the mapping
 * here keeps all env var names in one place.
 */
function get(key) {
  switch (key) {
    case 'nodeEnv':
      return nodeEnv();
    case 'port':
      return parseIntEnv('PORT', 3000);
    case 'logLevel':
      return (process.env.LOG_LEVEL || 'info').toLowerCase();
    case 'apiToken':
      return process.env.API_TOKEN || null;
    case 'jsonBodyLimit':
      return process.env.JSON_BODY_LIMIT || '100kb';
    case 'trustProxy':
      return process.env.TRUST_PROXY || false;
    case 'autoSyncDisabled':
      return parseBoolEnv('AUTO_SYNC_DISABLED', false);
    case 'autoSyncIntervalMs':
      return parseIntEnv('AUTO_SYNC_INTERVAL_MS', 5000);
    case 'notificationWebhookUrl':
      return process.env.NOTIFICATION_WEBHOOK_URL || null;
    case 'dispatchWebhookUrl':
      return process.env.DISPATCH_WEBHOOK_URL || null;
    case 'warpApiKey':
      return process.env.WARP_API_KEY || null;
    case 'warpApiBase':
      return process.env.WARP_API_BASE || null;
    case 'ozEnvironmentId':
      return process.env.OZ_ENVIRONMENT_ID || null;
    case 'defaultExecutionMode':
      return defaultExecutionMode();
    case 'miguelDispatchOrder':
      return miguelDispatchOrder();
    case 'miguelLocalFallback':
      return parseBoolEnv('MIGUEL_LOCAL_FALLBACK', true);
    case 'tasksDataFile':
      return process.env.TASKS_DATA_FILE || null;
    case 'notificationsDataFile':
      return process.env.NOTIFICATIONS_DATA_FILE || null;
    case 'dataDir':
      return process.env.DATA_DIR || null;
    case 'storeBackupLimit':
      return parseIntEnv('STORE_BACKUP_LIMIT', 3);
    case 'databaseUrl':
      return process.env.DATABASE_URL || null;
    case 'databaseSsl':
      return parseBoolEnv('DATABASE_SSL', false);
    case 'storageBackend': {
      const explicit = (process.env.STORAGE_BACKEND || '').toLowerCase();
      if (explicit === 'postgres') return 'postgres';
      if (explicit === 'json') return 'json';
      return process.env.DATABASE_URL ? 'postgres' : 'json';
    }
    default:
      return undefined;
  }
}

/**
 * Validate invariants that must hold before the HTTP server binds.
 * Throws an Error describing every failing rule at once.
 */
function validateForBoot() {
  const errors = [];

  if (isProduction() && !get('apiToken')) {
    errors.push(
      'API_TOKEN must be set when NODE_ENV=production '
        + '(protected routes would otherwise be open to the world).',
    );
  }

  const port = get('port');
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    errors.push(`PORT must be a valid TCP port (got: ${process.env.PORT}).`);
  }

  const validLevels = ['debug', 'info', 'warn', 'error'];
  if (!validLevels.includes(get('logLevel'))) {
    errors.push(
      `LOG_LEVEL must be one of ${validLevels.join(', ')} `
        + `(got: ${process.env.LOG_LEVEL}).`,
    );
  }

  const storeBackupLimit = get('storeBackupLimit');
  if (!Number.isFinite(storeBackupLimit) || storeBackupLimit < 0) {
    errors.push(
      `STORE_BACKUP_LIMIT must be a non-negative integer (got: ${process.env.STORE_BACKUP_LIMIT}).`,
    );
  }

  const storageBackend = get('storageBackend');
  if (!['json', 'postgres'].includes(storageBackend)) {
    errors.push(
      `STORAGE_BACKEND must be 'json' or 'postgres' (got: ${process.env.STORAGE_BACKEND}).`,
    );
  }

  if (storageBackend === 'postgres' && !get('databaseUrl')) {
    errors.push(
      'DATABASE_URL must be set when STORAGE_BACKEND=postgres.',
    );
  }

  const configuredDefaultMode = (process.env.DEFAULT_EXECUTION_MODE || '').trim().toLowerCase();
  if (configuredDefaultMode && !VALID_EXECUTION_MODES.includes(configuredDefaultMode)) {
    errors.push(
      `DEFAULT_EXECUTION_MODE must be one of ${VALID_EXECUTION_MODES.join(', ')} `
        + `(got: ${process.env.DEFAULT_EXECUTION_MODE}).`,
    );
  }

  const rawMiguelOrder = parseCsvEnv('MIGUEL_DISPATCH_ORDER', []);
  const invalidMiguelTargets = rawMiguelOrder.filter(
    (mode) => !VALID_MIGUEL_TARGETS.includes(mode),
  );
  if (invalidMiguelTargets.length > 0) {
    errors.push(
      `MIGUEL_DISPATCH_ORDER must contain only ${VALID_MIGUEL_TARGETS.join(', ')} `
        + `(got: ${process.env.MIGUEL_DISPATCH_ORDER}).`,
    );
  }

  if (errors.length > 0) {
    const err = new Error(
      `Invalid configuration:\n  - ${errors.join('\n  - ')}`,
    );
    err.code = 'INVALID_CONFIG';
    throw err;
  }

  return true;
}

module.exports = {
  get,
  isProduction,
  validateForBoot,
  // Exposed for tests / debugging.
  _internal: {
    parseIntEnv,
    parseBoolEnv,
    parseCsvEnv,
    defaultExecutionMode,
    miguelDispatchOrder,
    VALID_EXECUTION_MODES,
    VALID_MIGUEL_TARGETS,
  },
};
