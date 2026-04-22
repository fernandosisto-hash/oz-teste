/* eslint-disable no-console */
/**
 * Integration test for terminal-state notifications.
 *
 * Covers:
 *   1. dispatch (local mode, fast terminal)
 *        -> notification persisted, webhook POST received, task stamped
 *           with notifiedAt + notifiedStatus
 *   2. re-running the notify path (e.g. from a stray sync call)
 *        -> NO duplicate notification emitted, NO duplicate webhook POST
 *   3. dispatch + sync against an Oz run that completes later
 *        -> exactly one notification across the whole lifecycle, even
 *           though multiple sync ticks run after the task terminates
 *   4. webhook target down
 *        -> notification still persisted with delivery.ok=false; task
 *           still stamped as notified; no throw, no rollback
 *
 * No external network is touched. No production data files are written
 * — temporary TASKS_DATA_FILE / NOTIFICATIONS_DATA_FILE are used.
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_TASKS = path.join(
  os.tmpdir(),
  `oz-teste-notify-tasks-${process.pid}-${Date.now()}.json`,
);
const TMP_NOTIFS = path.join(
  os.tmpdir(),
  `oz-teste-notify-events-${process.pid}-${Date.now()}.json`,
);
process.env.TASKS_DATA_FILE = TMP_TASKS;
process.env.NOTIFICATIONS_DATA_FILE = TMP_NOTIFS;
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

/**
 * Webhook receiver. Records every incoming POST body so we can assert
 * on payload shape and delivery count.
 */
function startWebhookReceiver({ failWith = null } = {}) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      if (req.method !== 'POST') {
        res.writeHead(405);
        return res.end();
      }
      let parsed = null;
      try {
        parsed = body ? JSON.parse(body) : null;
      } catch (_) {
        parsed = { _raw: body };
      }
      received.push({ url: req.url, body: parsed });
      if (failWith) {
        res.writeHead(failWith, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'forced failure' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, received });
    });
  });
}

/**
 * Mock Oz server that scripts INPROGRESS -> SUCCEEDED across polls so
 * we can drive a task through dispatch + sync.
 */
function startMockOz() {
  const runs = new Map();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/api/v1/agent/run') {
        const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        runs.set(runId, {
          states: [
            'INPROGRESS', 'INPROGRESS', 'INPROGRESS', 'INPROGRESS', 'SUCCEEDED',
          ],
          attempts: 0,
          sessionLink: `https://app.warp.dev/session/${runId}`,
          resultSummary: 'oz run finished clean',
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
      const m = req.url && req.url.match(/^\/api\/v1\/agent\/runs\/([^/?]+)/);
      if (req.method === 'GET' && m) {
        const rec = runs.get(decodeURIComponent(m[1]));
        if (!rec) {
          res.writeHead(404);
          return res.end(JSON.stringify({ error: 'not found' }));
        }
        const idx = Math.min(rec.attempts, rec.states.length - 1);
        const state = rec.states[idx];
        rec.attempts += 1;
        const payload = {
          run_id: decodeURIComponent(m[1]),
          state,
          session_link: rec.sessionLink,
        };
        if (state === 'SUCCEEDED') payload.result_summary = rec.resultSummary;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(payload));
      }
      res.writeHead(404);
      return res.end(JSON.stringify({ error: 'not found' }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

(async function main() {
  let webhook;
  let mockOz;
  try {
    // ---------------------------------------------------------------
    // 1. dispatch(local) -> notification fires once
    // ---------------------------------------------------------------
    webhook = await startWebhookReceiver();
    process.env.NOTIFICATION_WEBHOOK_URL = `http://127.0.0.1:${webhook.port}/hook`;

    const taskStore = require('../src/store/taskStore');
    const dispatcher = require('../src/dispatcher');
    const notificationService = require('../src/notificationService');
    const notificationStore = require('../src/store/notificationStore');
    const syncService = require('../src/syncService');

    const t1 = taskStore.add({
      title: 'local task',
      description: 'terminates synchronously',
      executionMode: 'local',
    });
    const afterDispatch = await dispatcher.dispatch(t1, { mode: 'local' });
    assert.equal(afterDispatch.status, 'done');
    assert.ok(afterDispatch.finishedAt, 'finishedAt should be set');
    assert.ok(afterDispatch.notifiedAt, 'notifiedAt should be set on the task');
    assert.equal(afterDispatch.notifiedStatus, 'done');

    // Give the event loop a beat (webhook delivery is awaited, but be
    // defensive in case of any pending microtasks).
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(webhook.received.length, 1, 'exactly one webhook delivery');
    const payload = webhook.received[0].body;
    assert.equal(payload.event, 'task.terminal');
    assert.equal(payload.taskId, t1.id);
    assert.equal(payload.status, 'done');
    assert.ok(payload.notificationId, 'notificationId in payload');
    assert.ok(payload.runId, 'runId in payload');
    assert.ok(payload.finishedAt, 'finishedAt in payload');
    assert.ok(payload.completedAt, 'completedAt in payload');
    assert.ok(payload.emittedAt, 'emittedAt in payload');
    assert.equal(payload.dispatchMode, 'local');
    console.log('[ok] dispatch(local) emitted exactly one notification');

    const stored1 = notificationStore.getByTaskId(t1.id);
    assert.equal(stored1.length, 1, 'one persisted event');
    assert.equal(stored1[0].taskId, t1.id);
    assert.equal(stored1[0].delivery.ok, true);
    console.log('[ok] notification persisted with successful delivery');

    // ---------------------------------------------------------------
    // 2. calling notifyIfTerminal again is a no-op (dedupe)
    // ---------------------------------------------------------------
    const beforeCount = webhook.received.length;
    const retry = await notificationService.notifyIfTerminal(afterDispatch);
    assert.equal(retry.emitted, false);
    assert.equal(retry.reason, 'already_notified');
    assert.equal(webhook.received.length, beforeCount, 'no duplicate webhook');
    assert.equal(
      notificationStore.getByTaskId(t1.id).length,
      1,
      'no duplicate persisted event',
    );
    console.log('[ok] dedupe: repeat notifyIfTerminal did not re-emit');

    // ---------------------------------------------------------------
    // 3. dispatch(oz) + repeated sync ticks emit exactly one event
    // ---------------------------------------------------------------
    mockOz = await startMockOz();
    process.env.WARP_API_BASE = `http://127.0.0.1:${mockOz.port}`;

    const t2 = taskStore.add({
      title: 'oz task',
      description: 'finishes after a few sync ticks',
      executionMode: 'oz',
    });
    const afterOzDispatch = await dispatcher.dispatch(t2, { mode: 'oz' });
    // Mock scripts 4 INPROGRESS before SUCCEEDED, so dispatch's 3-poll
    // window leaves it in_progress. No notification yet.
    assert.equal(afterOzDispatch.status, 'in_progress');
    assert.equal(afterOzDispatch.notifiedAt, undefined);
    assert.equal(
      notificationStore.getByTaskId(t2.id).length,
      0,
      'no notification emitted while still in_progress',
    );

    const webhookCountBeforeSync = webhook.received.length;
    // Tick until the mock returns SUCCEEDED.
    let terminalHit = false;
    for (let i = 0; i < 10 && !terminalHit; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const r = await syncService.syncTask(t2.id);
      terminalHit = Boolean(r.terminal && !r.alreadyTerminal);
    }
    assert.ok(terminalHit, 'expected sync to reach terminal state');

    const finalT2 = taskStore.getById(t2.id);
    assert.equal(finalT2.status, 'done');
    assert.ok(finalT2.notifiedAt);
    assert.equal(finalT2.notifiedStatus, 'done');

    // Further sync ticks must NOT emit duplicates.
    await syncService.syncTask(t2.id);
    await syncService.syncTask(t2.id);

    const t2Events = notificationStore.getByTaskId(t2.id);
    assert.equal(
      t2Events.length,
      1,
      `expected exactly one event for task ${t2.id}, got ${t2Events.length}`,
    );
    assert.equal(
      webhook.received.length - webhookCountBeforeSync,
      1,
      'exactly one webhook delivery across the oz lifecycle',
    );
    const ozPayload = t2Events[0];
    assert.equal(ozPayload.dispatchMode, 'oz');
    assert.ok(ozPayload.sessionLink, 'sessionLink included for oz task');
    assert.ok(
      ozPayload.resultSummary && ozPayload.resultSummary.includes('oz run'),
      'resultSummary included for oz task',
    );
    console.log('[ok] oz dispatch + multiple sync ticks emitted exactly one event');

    // ---------------------------------------------------------------
    // 4. webhook delivery failure is recorded, not thrown
    // ---------------------------------------------------------------
    // Swap to a receiver that always returns 500.
    await new Promise((r) => webhook.server.close(r));
    webhook = await startWebhookReceiver({ failWith: 500 });
    process.env.NOTIFICATION_WEBHOOK_URL = `http://127.0.0.1:${webhook.port}/hook`;

    const t3 = taskStore.add({
      title: 'fails to deliver',
      executionMode: 'local',
    });
    const afterT3 = await dispatcher.dispatch(t3, { mode: 'local' });
    assert.equal(afterT3.status, 'done');
    assert.ok(afterT3.notifiedAt, 'task still stamped as notified');

    const t3Events = notificationStore.getByTaskId(t3.id);
    assert.equal(t3Events.length, 1);
    assert.equal(t3Events[0].delivery.ok, false);
    assert.equal(t3Events[0].delivery.httpStatus, 500);
    assert.ok(
      t3Events[0].delivery.error && /HTTP 500/.test(t3Events[0].delivery.error),
      `expected delivery.error to mention HTTP 500, got: ${t3Events[0].delivery.error}`,
    );
    console.log('[ok] webhook failure recorded on persisted event, no throw');

    // ---------------------------------------------------------------
    // 5. no webhook configured -> event still persisted, delivery.attempted=false
    // ---------------------------------------------------------------
    delete process.env.NOTIFICATION_WEBHOOK_URL;
    const t4 = taskStore.add({
      title: 'no webhook',
      executionMode: 'local',
    });
    const afterT4 = await dispatcher.dispatch(t4, { mode: 'local' });
    assert.equal(afterT4.status, 'done');
    const t4Events = notificationStore.getByTaskId(t4.id);
    assert.equal(t4Events.length, 1);
    assert.equal(t4Events[0].delivery.attempted, false);
    assert.equal(t4Events[0].delivery.reason, 'no_webhook_configured');
    console.log('[ok] no webhook configured: still persisted, no delivery attempted');

    console.log('\nALL NOTIFICATION TESTS PASSED');
    cleanup();
    if (webhook) webhook.server.close();
    if (mockOz) mockOz.server.close();
    process.exit(0);
  } catch (err) {
    console.error('TEST FAILURE:', err);
    cleanup();
    if (webhook) webhook.server.close();
    if (mockOz) mockOz.server.close();
    process.exit(1);
  }
})();
