const fs = require('fs');
const path = require('path');

function ensureDirExists(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function atomicWriteJson(filePath, payload) {
  ensureDirExists(filePath);
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tempFile = path.join(
    dir,
    `.${base}.${process.pid}.${Date.now()}.tmp`,
  );

  fs.writeFileSync(tempFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tempFile, filePath);
}

function rotateBackups(filePath, backupLimit) {
  const limit = Number.isFinite(backupLimit) ? backupLimit : 3;
  if (limit <= 0 || !fs.existsSync(filePath)) return;

  for (let i = limit - 1; i >= 1; i -= 1) {
    const from = `${filePath}.bak.${i}`;
    const to = `${filePath}.bak.${i + 1}`;
    if (fs.existsSync(from)) {
      fs.renameSync(from, to);
    }
  }

  fs.copyFileSync(filePath, `${filePath}.bak.1`);
}

function parseJsonFile(filePath, emptyStateFactory) {
  const raw = fs.readFileSync(filePath, 'utf8');
  if (!raw.trim()) return emptyStateFactory();
  return JSON.parse(raw);
}

function createJsonFileStore({
  filePath,
  emptyState,
  backupLimit = 3,
  label = 'store',
}) {
  if (!filePath) {
    throw new Error(`createJsonFileStore requires filePath for ${label}`);
  }

  if (typeof emptyState !== 'function') {
    throw new Error(`createJsonFileStore requires emptyState() for ${label}`);
  }

  let state = emptyState();
  let loaded = false;

  function load() {
    if (loaded) return state;

    try {
      if (fs.existsSync(filePath)) {
        state = parseJsonFile(filePath, emptyState);
      } else {
        state = emptyState();
        atomicWriteJson(filePath, state);
      }
    } catch (err) {
      const latestBackup = `${filePath}.bak.1`;
      if (fs.existsSync(latestBackup)) {
        try {
          state = parseJsonFile(latestBackup, emptyState);
          atomicWriteJson(filePath, state);
          loaded = true;
          return state;
        } catch (backupErr) {
          throw new Error(
            `Failed to load ${label} from ${filePath} and backup ${latestBackup}: ${backupErr.message}`,
          );
        }
      }

      throw new Error(`Failed to load ${label} from ${filePath}: ${err.message}`);
    }

    loaded = true;
    return state;
  }

  function save(nextState) {
    load();
    rotateBackups(filePath, backupLimit);
    state = nextState;
    atomicWriteJson(filePath, state);
    return state;
  }

  function getState() {
    return load();
  }

  function replaceState(updater) {
    const current = load();
    const next = typeof updater === 'function' ? updater(current) : updater;
    return save(next);
  }

  function resetForTests() {
    state = emptyState();
    loaded = false;
  }

  return {
    load,
    save,
    getState,
    replaceState,
    resetForTests,
    filePath,
  };
}

module.exports = {
  createJsonFileStore,
  atomicWriteJson,
  ensureDirExists,
};
