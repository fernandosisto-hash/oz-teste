const fs = require('fs');
const path = require('path');

/**
 * File-backed JSON store for terminal-state task notifications.
 *
 * Intentionally mirrors the shape of taskStore: sync reads, sync writes,
 * no database. Each record is an immutable event emitted when a task
 * reaches `done`, `failed`, or `cancelled`.
 *
 * File shape:
 *   { "notifications": [ <event>, ... ] }
 */

const DEFAULT_DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DEFAULT_DATA_FILE = path.join(DEFAULT_DATA_DIR, 'notifications.json');

const dataFile = process.env.NOTIFICATIONS_DATA_FILE
  ? path.resolve(process.env.NOTIFICATIONS_DATA_FILE)
  : DEFAULT_DATA_FILE;

let notifications = [];
let loaded = false;

function ensureDirExists(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function load() {
  if (loaded) return;
  try {
    if (fs.existsSync(dataFile)) {
      const raw = fs.readFileSync(dataFile, 'utf8');
      const parsed = raw.trim() ? JSON.parse(raw) : {};
      notifications = Array.isArray(parsed.notifications)
        ? parsed.notifications
        : [];
    } else {
      notifications = [];
      persist();
    }
  } catch (err) {
    throw new Error(
      `Failed to load notifications from ${dataFile}: ${err.message}`,
    );
  }
  loaded = true;
}

function persist() {
  ensureDirExists(dataFile);
  fs.writeFileSync(
    dataFile,
    JSON.stringify({ notifications }, null, 2),
    'utf8',
  );
}

function getAll() {
  load();
  return notifications.slice();
}

function getByTaskId(taskId) {
  load();
  const id = Number(taskId);
  return notifications.filter((n) => n.taskId === id);
}

function add(event) {
  load();
  notifications.push(event);
  persist();
  return event;
}

module.exports = {
  getAll,
  getByTaskId,
  add,
  // Exported for debugging/tests.
  _dataFile: dataFile,
};
