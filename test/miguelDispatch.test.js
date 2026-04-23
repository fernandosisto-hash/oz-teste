/* eslint-disable no-console */
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_TASKS = path.join(
  os.tmpdir(),
  `oz-teste-miguel-tasks-${process.pid}-${Date.now()}.json`,
);
const TMP_NOTIFS = path.join(
  os.tmpdir(),
  `oz-teste-miguel-notifs-${process.pid}-${Date.now()}.json`,
);
process.env.TASKS_DATA_FILE = TMP_TASKS;
process.env.NOTIFICATIONS_DATA_FILE = TMP_NOTIFS;
process.env.AUTO_SYNC_DISABLED = 'true';
process.env.DEFAULT_EXECUTION_MODE = 'miguel';
process.env.MIGUEL_DISPATCH_ORDER = 'webhook,oz,local';
delete process.env.API_TOKEN;
delete process.env.WARP_API_KEY;
delete process.env.WARP_API_BASE;

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

function startWebhookReceiver() {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      let parsed = null;
      try {
        parsed = body ? JSON.parse(body) : null;
      } catch (_) {
        parsed = { _raw: body };
      }
      received.push({ method: req.method, url: req.url, body: parsed });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, received });
    });
  });
}

(async function main() {
  let server;
  let webhook;
  try {
    webhook = await startWebhookReceiver();
    process.env.DISPATCH_WEBHOOK_URL = `http://127.0.0.1:${webhook.port}/dispatch`;
    process.env.MIGUEL_LOCAL_FALLBACK = 'true';

    const app = require('../src/app');
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = server.address();

    // ---------------------------------------------------------------
    // 1. default execution mode can come from env and be 'miguel'
    // ---------------------------------------------------------------
    const createdDefault = await request(port, {
      method: 'POST',
      path: '/tasks',
      body: { title: 'default miguel task' },
    });
    assert.equal(createdDefault.status, 201);
    assert.equal(createdDefault.body.executionMode, 'miguel');
    console.log('[ok] DEFAULT_EXECUTION_MODE=miguel is applied on task creation');

    // ---------------------------------------------------------------
    // 2. miguel picks webhook first when configured
    // ---------------------------------------------------------------
    const dispatchedWebhook = await request(port, {
      method: 'POST',
      path: `/tasks/${createdDefault.body.id}/dispatch`,
    });
    assert.equal(dispatchedWebhook.status, 202);
    assert.equal(dispatchedWebhook.body.status, 'done');
    assert.equal(dispatchedWebhook.body.dispatchMode, 'webhook');
    assert.equal(dispatchedWebhook.body.dispatchMeta.orchestrator, 'miguel');
    assert.equal(dispatchedWebhook.body.dispatchMeta.requestedMode, 'miguel');
    assert.equal(dispatchedWebhook.body.dispatchMeta.resolvedMode, 'webhook');
    assert.equal(dispatchedWebhook.body.dispatchMeta.fallbackUsed, false);
    assert.equal(dispatchedWebhook.body.dispatchMeta.candidates[0].mode, 'webhook');
    assert.equal(dispatchedWebhook.body.dispatchMeta.availability.webhook.available, true);
    assert.equal(webhook.received.length, 1);
    assert.equal(webhook.received[0].body.task.id, createdDefault.body.id);
    assert.equal(webhook.received[0].body.task.dispatchMeta.requestedMode, 'miguel');
    console.log('[ok] miguel resolves to webhook and persists decision metadata');

    // ---------------------------------------------------------------
    // 3. miguel falls back to local when remote targets are unavailable
    // ---------------------------------------------------------------
    delete process.env.DISPATCH_WEBHOOK_URL;
    const createdFallback = await request(port, {
      method: 'POST',
      path: '/tasks',
      body: { title: 'fallback local', executionMode: 'miguel' },
    });
    assert.equal(createdFallback.status, 201);

    const dispatchedFallback = await request(port, {
      method: 'POST',
      path: `/tasks/${createdFallback.body.id}/dispatch`,
    });
    assert.equal(dispatchedFallback.status, 202);
    assert.equal(dispatchedFallback.body.status, 'done');
    assert.equal(dispatchedFallback.body.dispatchMode, 'local');
    assert.equal(dispatchedFallback.body.dispatchMeta.resolvedMode, 'local');
    assert.equal(dispatchedFallback.body.dispatchMeta.fallbackUsed, true);
    assert.equal(
      dispatchedFallback.body.dispatchMeta.availability.webhook.available,
      false,
    );
    console.log('[ok] miguel falls back to local when webhook/oz are unavailable');

    // ---------------------------------------------------------------
    // 4. health/info expose orchestration runtime summary
    // ---------------------------------------------------------------
    const health = await request(port, { method: 'GET', path: '/health' });
    assert.equal(health.status, 200);
    assert.equal(health.body.status, 'ok');
    assert.equal(health.body.dispatch.defaultExecutionMode, 'miguel');
    assert.equal(health.body.dispatch.resolvedDefaultMode, 'local');
    assert.deepEqual(health.body.dispatch.miguel.order, ['webhook', 'oz', 'local']);

    const info = await request(port, { method: 'GET', path: '/info' });
    assert.equal(info.status, 200);
    assert.ok(info.body.dispatch.validModes.includes('miguel'));
    assert.equal(info.body.dispatch.miguel.localFallback, true);
    console.log('[ok] /health and /info expose miguel runtime data');

    // ---------------------------------------------------------------
    // 5. miguel can fail closed when local fallback is disabled
    // ---------------------------------------------------------------
    process.env.MIGUEL_LOCAL_FALLBACK = 'false';
    process.env.MIGUEL_DISPATCH_ORDER = 'webhook,oz';

    const createdFailed = await request(port, {
      method: 'POST',
      path: '/tasks',
      body: { title: 'no targets left', executionMode: 'miguel' },
    });
    assert.equal(createdFailed.status, 201);

    const failedDispatch = await request(port, {
      method: 'POST',
      path: `/tasks/${createdFailed.body.id}/dispatch`,
    });
    assert.equal(failedDispatch.status, 202);
    assert.equal(failedDispatch.body.status, 'failed');
    assert.equal(failedDispatch.body.dispatchMode, null);
    assert.equal(failedDispatch.body.dispatchMeta.resolvedMode, null);
    assert.ok(/could not resolve/i.test(failedDispatch.body.lastError));
    console.log('[ok] miguel fails with audit metadata when no target is available');

    console.log('\nALL MIGUEL DISPATCH TESTS PASSED');
    cleanup();
    server.close();
    webhook.server.close();
    process.exit(0);
  } catch (err) {
    console.error('TEST FAILURE:', err);
    cleanup();
    if (server) server.close();
    if (webhook) webhook.server.close();
    process.exit(1);
  }
})();
