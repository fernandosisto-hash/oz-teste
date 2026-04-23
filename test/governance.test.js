/* eslint-disable no-console */
/**
 * Integration test for the operational governance feature set:
 *   - task priority validation + ordering in bulk sync
 *   - local cancel endpoint + guard against cancelling terminal tasks
 *   - retry endpoint: budget enforcement, retryCount increment,
 *     failed -> retried lifecycle
 *   - timeout handling: stale in_progress -> failed w/ timedOut=true,
 *     terminal notification emitted
 *   - invalid-transition protection on PATCH /tasks/:id/status
 *
 * Uses a throwaway TASKS_DATA_FILE / NOTIFICATIONS_DATA_FILE under
 * os.tmpdir() and boots the Express app in-process. No external
 * network is touched.
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_TASKS = path.join(
  os.tmpdir(),
  `oz-teste-gov-tasks-${process.pid}-${Date.now()}.json`,
);
const TMP_NOTIFS = path.join(
  os.tmpdir(),
  `oz-teste-gov-notifs-${process.pid}-${Date.now()}.json`,
);
process.env.TASKS_DATA_FILE = TMP_TASKS;
process.env.NOTIFICATIONS_DATA_FILE = TMP_NOTIFS;
delete process.env.API_TOKEN;
delete process.env.NOTIFICATION_WEBHOOK_URL;
process.env.AUTO_SYNC_DISABLED = 'true';
process.env.WARP_API_KEY = 'test-key';

function cleanup() {
  for (const f of [TMP_TASKS, TMP_NOTIFS]) {
    try {
      fs.unlinkSync(f);
    } catch (_) {
      // ignore
    }
  }
}

function request(port, { method, path: urlPath, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: urlPath,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => {
          raw += c;
        });
        res.on('end', () => {
          let parsed = null;
          if (raw) {
            try {
              parsed = JSON.parse(raw);
            } catch (_) {
              parsed = raw;
            }
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

(async function main() {
  let server;
  try {
    const app = require('../src/app');
    const taskStore = require('../src/store/taskStore');
    const syncService = require('../src/syncService');
    const notificationStore = require('../src/store/notificationStore');
    const governance = require('../src/governance');

    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = server.address();

    // ---------------------------------------------------------------
    // 1. priority: valid value stored, default normal, invalid rejected
    // ---------------------------------------------------------------
    const createHigh = await request(port, {
      method: 'POST',
      path: '/tasks',
      body: { title: 'high prio', executionMode: 'local', priority: 'high' },
    });
    assert.equal(createHigh.status, 201);
    assert.equal(createHigh.body.priority, 'high');

    const createDefault = await request(port, {
      method: 'POST',
      path: '/tasks',
      body: { title: 'default prio', executionMode: 'local' },
    });
    assert.equal(createDefault.status, 201);
    assert.equal(createDefault.body.priority, 'normal');
    assert.equal(createDefault.body.retryCount, 0);

    const createBad = await request(port, {
      method: 'POST',
      path: '/tasks',
      body: { title: 'bad prio', executionMode: 'local', priority: 'ultra' },
    });
    assert.equal(createBad.status, 400);
    assert.ok(/priority/i.test(createBad.body.error));
    console.log('[ok] priority validation + default works');

    // ---------------------------------------------------------------
    // 2. timeout + maxRetries validation
    // ---------------------------------------------------------------
    const badTimeout = await request(port, {
      method: 'POST',
      path: '/tasks',
      body: { title: 't', executionMode: 'local', timeoutMs: -1 },
    });
    assert.equal(badTimeout.status, 400);
    assert.ok(/timeoutMs/i.test(badTimeout.body.error));

    const smallTimeout = await request(port, {
      method: 'POST',
      path: '/tasks',
      body: { title: 't', executionMode: 'local', timeoutMs: 50 },
    });
    assert.equal(smallTimeout.status, 400);
    assert.ok(/>=/.test(smallTimeout.body.error));

    const badRetries = await request(port, {
      method: 'POST',
      path: '/tasks',
      body: { title: 't', executionMode: 'local', maxRetries: -2 },
    });
    assert.equal(badRetries.status, 400);
    assert.ok(/maxRetries/i.test(badRetries.body.error));
    console.log('[ok] timeout + maxRetries input validation rejects bad values');

    // ---------------------------------------------------------------
    // 3. priority ordering in bulk syncInProgressTasks
    // ---------------------------------------------------------------
    // Seed three tasks directly in the store with fake runIds so the
    // sync service considers them syncable. We only assert the order
    // in which candidates are walked; the actual Oz API call errors
    // out (unknown run) and records lastError in order.
    const now = Date.now();
    const low = await taskStore.add({
      title: 'low', executionMode: 'oz', priority: 'low',
    });
    await taskStore.updateExecution(low.id, {
      status: 'in_progress',
      dispatchMode: 'oz',
      runId: 'r-low',
      dispatchedAt: new Date(now).toISOString(),
    });
    const high = await taskStore.add({
      title: 'high', executionMode: 'oz', priority: 'high',
    });
    await taskStore.updateExecution(high.id, {
      status: 'in_progress',
      dispatchMode: 'oz',
      runId: 'r-high',
      dispatchedAt: new Date(now + 5).toISOString(),
    });
    const normal = await taskStore.add({
      title: 'normal', executionMode: 'oz', priority: 'normal',
    });
    await taskStore.updateExecution(normal.id, {
      status: 'in_progress',
      dispatchMode: 'oz',
      runId: 'r-normal',
      dispatchedAt: new Date(now + 10).toISOString(),
    });
    // Point the Oz client at an unreachable URL so getRun fails fast.
    process.env.WARP_API_BASE = 'http://127.0.0.1:1';
    const bulk = await syncService.syncInProgressTasks();
    // Results come back in processing order. All three will fail (no
    // mock), but we can match by the embedded runId -> task id.
    const idsInOrder = bulk
      .map((r) => r.task.id)
      .filter((id) => [high.id, normal.id, low.id].includes(id));
    assert.deepEqual(idsInOrder, [high.id, normal.id, low.id]);
    console.log('[ok] bulk sync walks candidates in high->normal->low order');

    // ---------------------------------------------------------------
    // 4. cancel: valid from received, invalid when terminal
    // ---------------------------------------------------------------
    const toCancel = await request(port, {
      method: 'POST',
      path: '/tasks',
      body: { title: 'to-cancel', executionMode: 'local' },
    });
    const cancelled = await request(port, {
      method: 'POST',
      path: `/tasks/${toCancel.body.id}/cancel`,
    });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.status, 'cancelled');
    assert.ok(cancelled.body.cancelledAt);
    assert.ok(cancelled.body.finishedAt);
    assert.ok(cancelled.body.notifiedAt, 'terminal notification fired on cancel');
    assert.equal(cancelled.body.notifiedStatus, 'cancelled');

    const cancelEvents = await notificationStore.getByTaskId(toCancel.body.id);
    assert.equal(cancelEvents.length, 1);
    assert.equal(cancelEvents[0].status, 'cancelled');

    // Duplicate cancel -> 409
    const dup = await request(port, {
      method: 'POST',
      path: `/tasks/${toCancel.body.id}/cancel`,
    });
    assert.equal(dup.status, 409);
    assert.ok(/cannot be cancelled/i.test(dup.body.error));
    console.log('[ok] cancel works once; duplicate cancel rejected with 409');

    // Cancel of terminal 'done' task also rejected
    const doneTask = await request(port, {
      method: 'POST',
      path: '/tasks',
      body: { title: 'already-done', executionMode: 'local' },
    });
    await request(port, {
      method: 'POST',
      path: `/tasks/${doneTask.body.id}/dispatch`,
    });
    const cancelDone = await request(port, {
      method: 'POST',
      path: `/tasks/${doneTask.body.id}/cancel`,
    });
    assert.equal(cancelDone.status, 409);
    console.log('[ok] cannot cancel a task already in terminal state');

    // Cancel of a missing task -> 404
    const cancel404 = await request(port, {
      method: 'POST',
      path: '/tasks/999999/cancel',
    });
    assert.equal(cancel404.status, 404);

    // ---------------------------------------------------------------
    // 5. retry: budget enforcement + retryCount increment
    // ---------------------------------------------------------------
    // Create a task, force it to failed, then retry it.
    const retryable = await request(port, {
      method: 'POST',
      path: '/tasks',
      body: { title: 'retry me', executionMode: 'local', maxRetries: 1 },
    });
    // Force into failed (valid transition from received)
    const toFailed = await request(port, {
      method: 'PATCH',
      path: `/tasks/${retryable.body.id}/status`,
      body: { status: 'failed' },
    });
    assert.equal(toFailed.status, 200);
    assert.equal(toFailed.body.status, 'failed');

    // Retry once — should succeed (budget 1, used 0 -> 1)
    const retryOnce = await request(port, {
      method: 'POST',
      path: `/tasks/${retryable.body.id}/retry`,
    });
    assert.equal(retryOnce.status, 202);
    // Local dispatch immediately finishes 'done'
    assert.equal(retryOnce.body.status, 'done');
    assert.equal(retryOnce.body.retryCount, 1);

    // Retrying a done task -> 409
    const retryDone = await request(port, {
      method: 'POST',
      path: `/tasks/${retryable.body.id}/retry`,
    });
    assert.equal(retryDone.status, 409);
    assert.ok(/cannot be retried/.test(retryDone.body.error));

    // Force back to failed to test budget exhaustion. Going directly
    // via the store bypasses the done->failed transition guard (which
    // we validate separately below); the retry endpoint itself is
    // what we care about here.
    await taskStore.updateExecution(retryable.body.id, { status: 'failed' });
    // retryCount already 1, maxRetries=1 -> budget exhausted
    const retryExhausted = await request(port, {
      method: 'POST',
      path: `/tasks/${retryable.body.id}/retry`,
    });
    assert.equal(retryExhausted.status, 409);
    assert.ok(/budget exhausted/i.test(retryExhausted.body.error));
    assert.equal(retryExhausted.body.retryCount, 1);
    assert.equal(retryExhausted.body.maxRetries, 1);
    console.log('[ok] retry increments retryCount + rejects past budget');

    // ---------------------------------------------------------------
    // 6. timeout: stale in_progress task -> failed on sync
    // ---------------------------------------------------------------
    const stuck = await taskStore.add({
      title: 'stuck task',
      executionMode: 'oz',
      timeoutMs: 1000,
    });
    // Pretend it was dispatched 10s ago (well beyond timeout).
    const tenSecAgo = new Date(Date.now() - 10_000).toISOString();
    await taskStore.updateExecution(stuck.id, {
      status: 'in_progress',
      dispatchMode: 'oz',
      runId: 'r-stuck',
      dispatchedAt: tenSecAgo,
    });
    assert.equal(governance.hasTimedOut(await taskStore.getById(stuck.id)), true);

    const timedOut = await syncService.syncTask(stuck.id);
    assert.equal(timedOut.ok, true);
    assert.equal(timedOut.terminal, true);
    assert.equal(timedOut.timedOut, true);
    assert.equal(timedOut.task.status, 'failed');
    assert.equal(timedOut.task.timedOut, true);
    assert.ok(/timed out/i.test(timedOut.task.lastError));
    const stuckEvents = await notificationStore.getByTaskId(stuck.id);
    assert.equal(stuckEvents.length, 1);
    assert.equal(stuckEvents[0].status, 'failed');
    console.log('[ok] timeout: stale task marked failed + notification emitted');

    // ---------------------------------------------------------------
    // 7. invalid-transition protection on PATCH /tasks/:id/status
    // ---------------------------------------------------------------
    // The timed-out task is now 'failed'. Moving failed -> done is
    // not an allowed transition.
    const invalid = await request(port, {
      method: 'PATCH',
      path: `/tasks/${stuck.id}/status`,
      body: { status: 'done' },
    });
    assert.equal(invalid.status, 409);
    assert.ok(/invalid transition/i.test(invalid.body.error));

    // done is permanently terminal — cannot be moved anywhere.
    const alreadyDoneId = doneTask.body.id;
    const badFromDone = await request(port, {
      method: 'PATCH',
      path: `/tasks/${alreadyDoneId}/status`,
      body: { status: 'in_progress' },
    });
    assert.equal(badFromDone.status, 409);
    console.log('[ok] invalid status transitions rejected with 409');

    // Valid transition still works (failed -> received)
    const validAgain = await request(port, {
      method: 'PATCH',
      path: `/tasks/${stuck.id}/status`,
      body: { status: 'received' },
    });
    assert.equal(validAgain.status, 200);
    assert.equal(validAgain.body.status, 'received');
    console.log('[ok] valid transitions still succeed');

    console.log('\nALL GOVERNANCE TESTS PASSED');
    cleanup();
    server.close();
    process.exit(0);
  } catch (err) {
    console.error('TEST FAILURE:', err);
    cleanup();
    if (server) server.close();
    process.exit(1);
  }
})();
