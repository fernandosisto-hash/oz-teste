/* eslint-disable no-console */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createJsonFileStore } = require('../src/store/jsonFileStore');

const TMP_DIR = path.join(
  os.tmpdir(),
  `oz-teste-persistence-${process.pid}-${Date.now()}`,
);
const TMP_FILE = path.join(TMP_DIR, 'tasks.json');

function cleanup() {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch (_) {
    // ignore
  }
}

(function main() {
  try {
    const store = createJsonFileStore({
      filePath: TMP_FILE,
      label: 'tasks',
      backupLimit: 2,
      emptyState: () => ({ nextId: 1, tasks: [] }),
    });

    const initial = store.getState();
    assert.deepEqual(initial, { nextId: 1, tasks: [] });
    assert.ok(fs.existsSync(TMP_FILE));
    console.log('[ok] store bootstraps empty file');

    store.save({
      nextId: 2,
      tasks: [{ id: 1, title: 'primeira task' }],
    });
    store.save({
      nextId: 3,
      tasks: [
        { id: 1, title: 'primeira task' },
        { id: 2, title: 'segunda task' },
      ],
    });

    assert.ok(fs.existsSync(`${TMP_FILE}.bak.1`));
    console.log('[ok] store creates rotating backup');

    fs.writeFileSync(TMP_FILE, '{ arquivo quebrado', 'utf8');

    const recoveredStore = createJsonFileStore({
      filePath: TMP_FILE,
      label: 'tasks',
      backupLimit: 2,
      emptyState: () => ({ nextId: 1, tasks: [] }),
    });

    const recovered = recoveredStore.getState();
    assert.equal(recovered.nextId, 2);
    assert.equal(recovered.tasks.length, 1);
    assert.equal(recovered.tasks[0].title, 'primeira task');
    console.log('[ok] store recovers from latest backup if primary file is corrupt');

    console.log('\nALL PERSISTENCE TESTS PASSED');
  } finally {
    cleanup();
  }
}());
