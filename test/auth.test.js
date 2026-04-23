/* eslint-disable no-console */
/**
 * Integration test for the API_TOKEN shared-secret auth middleware.
 *
 * Covers:
 *   1. API_TOKEN unset -> protected routes are open (zero-config dev)
 *   2. API_TOKEN set + no header -> 401 on protected routes
 *   3. API_TOKEN set + wrong token -> 403 on protected routes
 *   4. API_TOKEN set + correct Bearer token -> 2xx on protected routes
 *   5. API_TOKEN set + correct X-API-Token header -> 2xx on protected routes
 *   6. /health and /info stay open even when API_TOKEN is set
 *   7. Existing task create/list behavior is preserved behind auth
 *
 * Uses a throwaway TASKS_DATA_FILE / NOTIFICATIONS_DATA_FILE under
 * os.tmpdir() and boots the Express app in-process against an
 * ephemeral port. No external network is touched.
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_TASKS = path.join(
  os.tmpdir(),
  `oz-teste-auth-tasks-${process.pid}-${Date.now()}.json`,
);
const TMP_NOTIFS = path.join(
  os.tmpdir(),
  `oz-teste-auth-notifs-${process.pid}-${Date.now()}.json`,
);
process.env.TASKS_DATA_FILE = TMP_TASKS;
process.env.NOTIFICATIONS_DATA_FILE = TMP_NOTIFS;
// Make sure we start with auth disabled; individual test stages toggle
// API_TOKEN on/off to exercise both configurations.
delete process.env.API_TOKEN;
// Keep auto-sync inert in the test.
process.env.AUTO_SYNC_DISABLED = 'true';

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
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = server.address();

    // ---------------------------------------------------------------
    // 1. API_TOKEN unset -> protected routes are open
    // ---------------------------------------------------------------
    assert.equal(process.env.API_TOKEN, undefined);
    const openList = await request(port, { method: 'GET', path: '/tasks' });
    assert.equal(openList.status, 200, 'GET /tasks should be open without API_TOKEN');
    assert.ok(Array.isArray(openList.body.tasks));
    console.log('[ok] API_TOKEN unset -> GET /tasks is open (200)');

    const openCreate = await request(port, {
      method: 'POST',
      path: '/tasks',
      body: { title: 'no-auth task', executionMode: 'local' },
    });
    assert.equal(openCreate.status, 201);
    assert.equal(openCreate.body.title, 'no-auth task');
    console.log('[ok] API_TOKEN unset -> POST /tasks is open (201)');

    // ---------------------------------------------------------------
    // 2. API_TOKEN set + no credentials -> 401
    // ---------------------------------------------------------------
    const TOKEN = 'super-secret-token-123';
    process.env.API_TOKEN = TOKEN;

    const missing = await request(port, { method: 'GET', path: '/tasks' });
    assert.equal(missing.status, 401, 'missing token should 401');
    assert.ok(/authentication required/i.test(missing.body.error));
    console.log('[ok] API_TOKEN set + no header -> 401');

    const missingNotifs = await request(port, {
      method: 'GET',
      path: '/notifications',
    });
    assert.equal(missingNotifs.status, 401);
    console.log('[ok] API_TOKEN set + no header -> /notifications also 401');

    // ---------------------------------------------------------------
    // 3. API_TOKEN set + wrong token -> 403
    // ---------------------------------------------------------------
    const wrong = await request(port, {
      method: 'GET',
      path: '/tasks',
      headers: { Authorization: 'Bearer nope-nope-nope' },
    });
    assert.equal(wrong.status, 403, 'wrong token should 403');
    assert.ok(/invalid token/i.test(wrong.body.error));
    console.log('[ok] API_TOKEN set + wrong token -> 403');

    const wrongXHeader = await request(port, {
      method: 'GET',
      path: '/tasks',
      headers: { 'X-API-Token': 'also-wrong' },
    });
    assert.equal(wrongXHeader.status, 403);
    console.log('[ok] API_TOKEN set + wrong X-API-Token -> 403');

    // ---------------------------------------------------------------
    // 4. API_TOKEN set + correct Bearer -> 200 / 201
    // ---------------------------------------------------------------
    const okBearer = await request(port, {
      method: 'GET',
      path: '/tasks',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(okBearer.status, 200);
    assert.ok(Array.isArray(okBearer.body.tasks));
    console.log('[ok] API_TOKEN set + correct Bearer -> 200');

    const okCreate = await request(port, {
      method: 'POST',
      path: '/tasks',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: { title: 'authed task', executionMode: 'local' },
    });
    assert.equal(okCreate.status, 201);
    assert.equal(okCreate.body.title, 'authed task');
    assert.equal(okCreate.body.status, 'received');
    console.log('[ok] API_TOKEN set + correct Bearer -> POST /tasks 201');

    // ---------------------------------------------------------------
    // 5. API_TOKEN set + correct X-API-Token -> 200
    // ---------------------------------------------------------------
    const okXToken = await request(port, {
      method: 'GET',
      path: '/tasks',
      headers: { 'X-API-Token': TOKEN },
    });
    assert.equal(okXToken.status, 200);
    console.log('[ok] API_TOKEN set + correct X-API-Token -> 200');

    // ---------------------------------------------------------------
    // 6. /health and /info remain open even with API_TOKEN set
    // ---------------------------------------------------------------
    const health = await request(port, { method: 'GET', path: '/health' });
    assert.equal(health.status, 200);
    assert.equal(health.body.status, 'ok');
    assert.equal(health.body.checks.storage.ok, true);
    assert.equal(health.body.env.apiTokenConfigured, true);
    console.log('[ok] /health is open even when API_TOKEN is set');

    const info = await request(port, { method: 'GET', path: '/info' });
    assert.equal(info.status, 200);
    assert.ok(info.body.name, 'info should expose app name');
    assert.equal(info.body.checks.storage.ok, true);
    assert.equal(info.body.env.storageBackend, 'json');
    console.log('[ok] /info is open even when API_TOKEN is set');

    // ---------------------------------------------------------------
    // 7. /notifications accessible with a valid token
    // ---------------------------------------------------------------
    const notifs = await request(port, {
      method: 'GET',
      path: '/notifications',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(notifs.status, 200);
    assert.ok(Array.isArray(notifs.body.notifications));
    console.log('[ok] /notifications works with a valid token');

    console.log('\nALL AUTH TESTS PASSED');
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
