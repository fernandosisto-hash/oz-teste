const crypto = require('crypto');
const taskStore = require('./store/taskStore');
const notificationStore = require('./store/notificationStore');

/**
 * Task terminal-state notification service.
 *
 * When a task transitions into a terminal state (`done`, `failed`, or
 * `cancelled`), this module:
 *
 *   1. Builds a notification payload describing the outcome.
 *   2. Persists the event to the notification store (audit trail +
 *      pull-based consumers via GET /notifications).
 *   3. Best-effort POSTs the payload to NOTIFICATION_WEBHOOK_URL if it
 *      is configured.
 *   4. Stamps the task with `notifiedAt` + `notifiedStatus` so repeated
 *      sync / poll cycles do not re-emit for the same terminal outcome.
 *
 * Delivery is best-effort: a webhook failure does NOT roll the task
 * back to non-terminal, does NOT throw, and is recorded on the stored
 * event. This keeps task lifecycle decoupled from notification
 * transport and avoids poisoning dispatch/sync with webhook flakiness.
 *
 * Intentionally simple: no retries, no queue, no worker. The stored
 * events act as the source of truth for downstream systems that prefer
 * a pull model or need to re-deliver out-of-band.
 */

const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled']);

function isTerminal(task) {
  return Boolean(task && TERMINAL_STATUSES.has(task.status));
}

/**
 * Shape the outbound payload. Kept small and stable — downstream
 * consumers (webhook handlers, audit tailers) should be able to rely
 * on these fields.
 */
function buildPayload(task, emittedAt) {
  return {
    event: 'task.terminal',
    notificationId: crypto.randomUUID(),
    taskId: task.id,
    status: task.status,
    runId: task.runId || null,
    sessionLink: task.sessionLink || null,
    resultSummary: task.resultSummary || null,
    lastError: task.lastError || null,
    finishedAt: task.finishedAt || null,
    completedAt: task.completedAt || null,
    dispatchMode: task.dispatchMode || null,
    emittedAt,
  };
}

async function deliverWebhook(payload, url) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      return {
        ok: false,
        attempted: true,
        httpStatus: res.status,
        error: `webhook responded with HTTP ${res.status}`,
      };
    }
    return { ok: true, attempted: true, httpStatus: res.status };
  } catch (err) {
    return {
      ok: false,
      attempted: true,
      error: `webhook request failed: ${err.message}`,
    };
  }
}

/**
 * Emit a terminal-state notification for the given task, if one has not
 * already been emitted for its current status.
 *
 * Returns:
 *   { emitted: false, reason }                  - nothing to do
 *   { emitted: true, notification, delivery,
 *     task }                                    - event was persisted
 *
 * Never throws. Webhook failures are recorded on the stored event.
 */
async function notifyIfTerminal(task, { logger = console } = {}) {
  if (!isTerminal(task)) {
    return { emitted: false, reason: 'not_terminal' };
  }

  // Dedupe: once a task has been notified for a given terminal status,
  // do not re-notify. `notifiedStatus` tracks the status we announced
  // so a subsequent transition (e.g. failed -> retried -> done) could
  // legitimately produce a second event in the future.
  if (task.notifiedAt && task.notifiedStatus === task.status) {
    return { emitted: false, reason: 'already_notified' };
  }

  const emittedAt = new Date().toISOString();
  const payload = buildPayload(task, emittedAt);

  const url = process.env.NOTIFICATION_WEBHOOK_URL;
  let delivery;
  if (url) {
    delivery = await deliverWebhook(payload, url);
  } else {
    delivery = { ok: true, attempted: false, reason: 'no_webhook_configured' };
  }

  if (!delivery.ok && logger && typeof logger.warn === 'function') {
    logger.warn(
      `[notify] webhook delivery failed for task=${task.id}: ${delivery.error}`,
    );
  }

  // Persist the event BEFORE stamping the task so an audit record
  // exists even if the task update somehow fails.
  const stored = notificationStore.add({ ...payload, delivery });

  const updatedTask = taskStore.updateExecution(task.id, {
    notifiedAt: emittedAt,
    notifiedStatus: task.status,
  });

  return {
    emitted: true,
    notification: stored,
    delivery,
    task: updatedTask || task,
  };
}

module.exports = {
  notifyIfTerminal,
  TERMINAL_STATUSES: Array.from(TERMINAL_STATUSES),
  // exported for tests / debugging
  _buildPayload: buildPayload,
  _isTerminal: isTerminal,
};
