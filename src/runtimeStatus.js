const fs = require('fs');
const path = require('path');
const config = require('./config');
const orchestration = require('./orchestration');
const taskStore = require('./store/taskStore');
const notificationStore = require('./store/notificationStore');
const postgresClient = require('./store/postgresClient');

function envSummary() {
  return {
    nodeEnv: config.get('nodeEnv'),
    storageBackend: config.get('storageBackend'),
    apiTokenConfigured: Boolean(config.get('apiToken')),
    autoSyncDisabled: config.get('autoSyncDisabled'),
    defaultExecutionMode: config.get('defaultExecutionMode'),
  };
}

function jsonStorePaths() {
  const tasksImpl = taskStore._selectedStore();
  const notificationsImpl = notificationStore._selectedStore();
  return {
    tasksFile: tasksImpl._dataFile || null,
    notificationsFile: notificationsImpl._dataFile || null,
  };
}

function checkJsonStorage() {
  const files = jsonStorePaths();
  const dirs = [files.tasksFile, files.notificationsFile]
    .filter(Boolean)
    .map((file) => path.dirname(file));

  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK);
  }

  return {
    ok: true,
    backend: 'json',
    files,
  };
}

async function checkPostgresStorage() {
  if (!postgresClient.isConfigured()) {
    return {
      ok: false,
      backend: 'postgres',
      error: 'DATABASE_URL is not configured',
    };
  }

  await postgresClient.query('SELECT 1 AS ok');
  return {
    ok: true,
    backend: 'postgres',
    configured: true,
  };
}

async function storageCheck() {
  const backend = config.get('storageBackend');
  try {
    if (backend === 'postgres') {
      return await checkPostgresStorage();
    }
    return checkJsonStorage();
  } catch (err) {
    return {
      ok: false,
      backend,
      error: err.message,
    };
  }
}

async function build() {
  const runtime = orchestration.runtimeSummary();
  const storage = await storageCheck();
  const ok = Boolean(storage.ok);

  return {
    status: ok ? 'ok' : 'degraded',
    checks: {
      storage,
    },
    env: envSummary(),
    dispatch: {
      defaultExecutionMode: runtime.defaultExecutionMode,
      resolvedDefaultMode: runtime.resolvedDefaultMode,
      miguel: runtime.miguel,
    },
  };
}

module.exports = {
  build,
};
