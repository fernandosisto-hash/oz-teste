/* eslint-disable no-console */
/**
 * Integration test for the automatic sync feature.
 *
 * Stands up a tiny in-process mock of the Warp Oz REST API, points the
 * dispatcher/sync service at it via WARP_API_BASE, and walks through:
 *
 *   1. create task (persisted to a temporary tasks.json)
 *   2. dispatch to 'oz' mode -> mock returns INPROGRESS
 *   3. auto-sync tick #1    -> mock still returns INPROGRESS
 *   4. auto-sync tick #2    -> mock returns SUCCEEDED with result
 *                              summary; task becomes 'done' with
 *                              finishedAt, completedAt, resultSummary
 *   5. error path: a non-existent runId produces lastError and keeps
 *                  the task in_progress
 *
 * No external network is touched. No production data files are written
 * — the test uses a throwaway TASKS_DATA_FILE under os.tmpdir().
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Point the task store at a scratch file BEFORE requiring the modules,
// because taskStore resolves the path at require-time.
const TMP_DATA = path.join(
  os.tmpdir(),
  `oz-teste-autosync-${process.pid}-${Date.now()}.json`,
);
process.env.TASKS_DATA_FILE = TMP_DATA;
process.env.WARP_API_KEY = 'test-key';

function cleanup() {
  try {
    fs.unlinkSync(TMP_DATA);
  } catch (_) {
    // ignore
  }
}

/**
 * Spin up a mock Oz server. It tracks each known run and advances its
 * state across polls according to the scripted `states` sequence.
 * Unknown run ids return 404.
 */
function startMockOz() {
  const runs = new Map(); // runId -> { states: [...], attempts, resultSummary }

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      // POST /api/v1/agent/run  -> create a new run
      if (req.method === 'POST' && req.url === '/api/v1/agent/run') {
        let payload = {};
        try {
          payload = body ? JSON.parse(body) : {};
        } catch (_) {
          payload = {};
        }
        const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        // Long enough sequence that dispatch's brief 3-poll window does
        // NOT reach a terminal state; the sync service must finish it.
        runs.set(runId, {
          states: [
            'INPROGRESS', 'INPROGRESS', 'INPROGRESS',
            'INPROGRESS', 'SUCCEEDED',
          ],
          attempts: 0,
          resultSummary: `completed: ${payload.prompt || 'job'}`,
          sessionLink: `https://app.warp.dev/session/${runId}`,
        });
        res.writeHead(201, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            run_id: runId,
            session_link: runs.get(runId).sessionLink,
            state: 'INPROGRESS',
          }),
        );
      }

      // GET /api/v1/agent/runs/:runId
      const getMatch = req.url && req.url.match(/^\/api\/v1\/agent\/runs\/([^/?]+)/);
      if (req.method === 'GET' && getMatch) {
        const runId = decodeURIComponent(getMatch[1]);
        const record = runs.get(runId);
        if (!record) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'run not found' }));
        }
        const idx = Math.min(record.attempts, record.states.length - 1);
        const state = record.states[idx];
        record.attempts += 1;
        const payload = {
          run_id: runId,
          state,
          session_link: record.sessionLink,
        };
        if (state === 'SUCCEEDED') {
          payload.result_summary = record.resultSummary;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(payload));
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found' }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

(async function main() {
  let mock;
  try {
    mock = await startMockOz();
    process.env.WARP_API_BASE = `http://127.0.0.1:${mock.port}`;

    // Require AFTER env is set so that taskStore picks up TMP_DATA.
    const taskStore = require('../src/store/taskStore');
    const dispatcher = require('../src/dispatcher');
    const syncService = require('../src/syncService');

    // --- 1. create task --------------------------------------------------
    const created = taskStore.add({
      title: 'hello auto-sync',
      description: 'end-to-end autosync validation',
      executionMode: 'oz',
    });
    assert.equal(created.status, 'received');
    console.log(`[ok] task created id=${created.id}, status=${created.status}`);

    // --- 2. dispatch to oz mode -----------------------------------------
    const afterDispatch = await dispatcher.dispatch(created, { mode: 'oz' });
    // The mock scripts 4 INPROGRESS followed by SUCCEEDED. Dispatch's
    // brief 3-poll window keeps the task `in_progress` after dispatch;
    // the sync service is responsible for driving it to terminal.
    assert.equal(afterDispatch.dispatchMode, 'oz');
    assert.ok(afterDispatch.runId, 'expected runId after dispatch');
    assert.ok(afterDispatch.sessionLink, 'expected sessionLink after dispatch');
    assert.ok(afterDispatch.dispatchedAt, 'expected dispatchedAt');
    assert.equal(afterDispatch.status, 'in_progress');
    assert.equal(afterDispatch.completedAt, null);
    assert.equal(afterDispatch.finishedAt, null);
    console.log(
      `[ok] dispatched -> status=${afterDispatch.status} runId=${afterDispatch.runId}`,
    );

    // --- 3. first sync tick: still in_progress --------------------------
    const sync1 = await syncService.syncTask(afterDispatch.id);
    assert.equal(sync1.ok, true);
    assert.equal(sync1.terminal, false);
    assert.equal(sync1.task.status, 'in_progress');
    console.log(`[ok] sync tick #1 -> status=${sync1.task.status}`);

    // --- 4. second sync tick: terminal done -----------------------------
    const sync2 = await syncService.syncTask(afterDispatch.id);
    assert.equal(sync2.ok, true);
    assert.equal(sync2.terminal, true);
    assert.equal(sync2.task.status, 'done');
    assert.equal(sync2.task.runState, 'SUCCEEDED');
    assert.ok(sync2.task.completedAt, 'expected completedAt to be set');
    assert.ok(sync2.task.finishedAt, 'expected finishedAt to be set');
    assert.ok(
      sync2.task.resultSummary && sync2.task.resultSummary.includes('completed'),
      `expected resultSummary to be set, got ${sync2.task.resultSummary}`,
    );
    assert.equal(sync2.task.lastError, null);
    console.log(
      `[ok] sync tick #2 -> status=${sync2.task.status} resultSummary="${sync2.task.resultSummary}"`,
    );

    // --- 4b. idempotency: syncing a terminal task is a no-op ------------
    const sync3 = await syncService.syncTask(afterDispatch.id);
    assert.equal(sync3.ok, true);
    assert.equal(sync3.alreadyTerminal, true);
    console.log('[ok] syncing a terminal task is a no-op');

    // --- 5. error path: forge a task with an unknown runId --------------
    const broken = taskStore.add({
      title: 'broken runId',
      executionMode: 'oz',
    });
    taskStore.updateExecution(broken.id, {
      status: 'in_progress',
      dispatchMode: 'oz',
      runId: 'run-does-not-exist',
      sessionLink: null,
      runState: 'INPROGRESS',
      dispatchedAt: new Date().toISOString(),
    });
    const syncBroken = await syncService.syncTask(broken.id);
    assert.equal(syncBroken.ok, false);
    assert.ok(
      syncBroken.task.lastError && /sync failed/i.test(syncBroken.task.lastError),
      `expected lastError to be recorded, got ${syncBroken.task.lastError}`,
    );
    // Should stay in_progress (not silently marked failed).
    assert.equal(syncBroken.task.status, 'in_progress');
    console.log(
      `[ok] error path -> lastError recorded, status stayed ${syncBroken.task.status}`,
    );

    // --- 6. bulk reconciliation smoke test ------------------------------
    const bulk = await syncService.syncInProgressTasks();
    // broken task is the only one still active; its sync will fail again.
    assert.ok(Array.isArray(bulk));
    assert.equal(bulk.length, 1);
    assert.equal(bulk[0].ok, false);
    console.log(`[ok] syncInProgressTasks found ${bulk.length} active task(s)`);

    // --- 7. auto-sync loop smoke test -----------------------------------
    // Prove that startAutoSync/stopAutoSync actually tick. We reuse the
    // broken task; each tick should append another lastError write.
    const before = taskStore.getById(broken.id).updatedAt;
    syncService.startAutoSync({ intervalMs: 500 });
    await new Promise((r) => setTimeout(r, 1300));
    syncService.stopAutoSync();
    const after = taskStore.getById(broken.id).updatedAt;
    assert.notEqual(before, after, 'expected auto-sync tick to update task');
    console.log('[ok] startAutoSync/stopAutoSync ticked at least once');

    console.log('\nALL AUTO-SYNC TESTS PASSED');
    cleanup();
    mock.server.close();
    process.exit(0);
  } catch (err) {
    console.error('TEST FAILURE:', err);
    cleanup();
    if (mock) mock.server.close();
    process.exit(1);
  }
})();
