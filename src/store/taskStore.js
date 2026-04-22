const fs = require('fs');
const path = require('path');

/**
 * Simple file-backed JSON store for tasks.
 *
 * Persists tasks to a JSON file on disk so that data survives across
 * server restarts. Intentionally minimal: reads on startup, writes
 * synchronously after every mutation. No database, no locking.
 *
 * File shape:
 *   {
 *     "nextId": <number>,
 *     "tasks":  [ <task>, ... ]
 *   }
 */

const DEFAULT_DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DEFAULT_DATA_FILE = path.join(DEFAULT_DATA_DIR, 'tasks.json');

const dataFile = process.env.TASKS_DATA_FILE
  ? path.resolve(process.env.TASKS_DATA_FILE)
  : DEFAULT_DATA_FILE;

let tasks = [];
let nextId = 1;
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
      tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
      if (Number.isInteger(parsed.nextId) && parsed.nextId > 0) {
        nextId = parsed.nextId;
      } else {
        // Derive nextId from existing tasks if missing/invalid.
        nextId = tasks.reduce((max, t) => Math.max(max, Number(t.id) || 0), 0) + 1;
      }
    } else {
      // First run: start empty and persist an initial file.
      tasks = [];
      nextId = 1;
      persist();
    }
  } catch (err) {
    // If the file is corrupt, fail loudly rather than silently dropping data.
    throw new Error(
      `Failed to load tasks from ${dataFile}: ${err.message}`,
    );
  }

  loaded = true;
}

function persist() {
  ensureDirExists(dataFile);
  const payload = JSON.stringify({ nextId, tasks }, null, 2);
  fs.writeFileSync(dataFile, payload, 'utf8');
}

function getAll() {
  load();
  return tasks.slice();
}

function getById(id) {
  load();
  return tasks.find((t) => t.id === Number(id));
}

function add({ title, description }) {
  load();
  const task = {
    id: nextId++,
    title,
    description: description || null,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  tasks.push(task);
  persist();
  return task;
}

function updateStatus(id, status) {
  load();
  const task = tasks.find((t) => t.id === Number(id));
  if (!task) return null;
  task.status = status;
  task.updatedAt = new Date().toISOString();
  persist();
  return task;
}

module.exports = {
  getAll,
  getById,
  add,
  updateStatus,
  // Exported for debugging/tests.
  _dataFile: dataFile,
};
