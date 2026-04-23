const path = require('path');
const config = require('../config');
const { createJsonFileStore } = require('./jsonFileStore');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', '..', 'data');
const resolvedDataDir = config.get('dataDir') || DEFAULT_DATA_DIR;
const DEFAULT_DATA_FILE = path.join(resolvedDataDir, 'tasks.json');

const dataFile = config.get('tasksDataFile')
  ? path.resolve(config.get('tasksDataFile'))
  : DEFAULT_DATA_FILE;

const store = createJsonFileStore({
  filePath: dataFile,
  label: 'tasks',
  backupLimit: config.get('storeBackupLimit'),
  emptyState: () => ({ nextId: 1, tasks: [] }),
});

function cloneTask(task) {
  return task ? { ...task } : task;
}

function getSnapshot() {
  const state = store.getState();
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const nextId = Number.isInteger(state.nextId) && state.nextId > 0
    ? state.nextId
    : tasks.reduce((max, t) => Math.max(max, Number(t.id) || 0), 0) + 1;

  return { nextId, tasks };
}

function init() {
  store.load();
  return true;
}

function getAll() {
  const { tasks } = getSnapshot();
  return tasks.map(cloneTask);
}

function getById(id) {
  const numericId = Number(id);
  const { tasks } = getSnapshot();
  return cloneTask(tasks.find((t) => t.id === numericId));
}

function add({
  title,
  description,
  executionMode,
  priority,
  timeoutMs,
  maxRetries,
}) {
  const task = store.replaceState((current) => {
    const snapshot = {
      nextId:
        Number.isInteger(current.nextId) && current.nextId > 0
          ? current.nextId
          : 1,
      tasks: Array.isArray(current.tasks) ? current.tasks.slice() : [],
    };

    const record = {
      id: snapshot.nextId,
      title,
      description: description || null,
      executionMode: executionMode || 'local',
      status: 'received',
      priority: priority || 'normal',
      timeoutMs: timeoutMs == null ? null : Number(timeoutMs),
      retryCount: 0,
      maxRetries: Number.isFinite(maxRetries) ? Number(maxRetries) : null,
      createdAt: new Date().toISOString(),
    };

    snapshot.tasks.push(record);
    snapshot.nextId += 1;
    return snapshot;
  });

  return cloneTask(task.tasks[task.tasks.length - 1]);
}

function updateStatus(id, status) {
  return updateExecution(id, { status });
}

function updateExecution(id, patch) {
  const numericId = Number(id);
  let updatedTask = null;

  store.replaceState((current) => {
    const snapshot = {
      nextId:
        Number.isInteger(current.nextId) && current.nextId > 0
          ? current.nextId
          : 1,
      tasks: Array.isArray(current.tasks) ? current.tasks.slice() : [],
    };

    const index = snapshot.tasks.findIndex((t) => t.id === numericId);
    if (index === -1) return snapshot;

    updatedTask = {
      ...snapshot.tasks[index],
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    snapshot.tasks[index] = updatedTask;
    return snapshot;
  });

  return cloneTask(updatedTask);
}

module.exports = {
  init,
  getAll,
  getById,
  add,
  updateStatus,
  updateExecution,
  _dataFile: dataFile,
  _store: store,
  kind: 'json',
};
