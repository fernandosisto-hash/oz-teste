const path = require('path');
const config = require('../config');
const { createJsonFileStore } = require('./jsonFileStore');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', '..', 'data');
const resolvedDataDir = config.get('dataDir') || DEFAULT_DATA_DIR;
const DEFAULT_DATA_FILE = path.join(resolvedDataDir, 'notifications.json');

const dataFile = config.get('notificationsDataFile')
  ? path.resolve(config.get('notificationsDataFile'))
  : DEFAULT_DATA_FILE;

const store = createJsonFileStore({
  filePath: dataFile,
  label: 'notifications',
  backupLimit: config.get('storeBackupLimit'),
  emptyState: () => ({ notifications: [] }),
});

function getSnapshot() {
  const state = store.getState();
  return Array.isArray(state.notifications) ? state.notifications : [];
}

function init() {
  store.load();
  return true;
}

function getAll() {
  return getSnapshot().map((item) => ({ ...item }));
}

function getByTaskId(taskId) {
  const id = Number(taskId);
  return getSnapshot()
    .filter((n) => n.taskId === id)
    .map((item) => ({ ...item }));
}

function add(event) {
  store.replaceState((current) => {
    const snapshot = {
      notifications: Array.isArray(current.notifications)
        ? current.notifications.slice()
        : [],
    };
    snapshot.notifications.push(event);
    return snapshot;
  });
  return { ...event };
}

module.exports = {
  init,
  getAll,
  getByTaskId,
  add,
  _dataFile: dataFile,
  _store: store,
  kind: 'json',
};
