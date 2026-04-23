const crypto = require('crypto');
const config = require('./config');
const taskStore = require('./store/taskStore');
const notificationStore = require('./store/notificationStore');

const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled']);

function isTerminal(task) {
  return Boolean(task && TERMINAL_STATUSES.has(task.status));
}

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

async function notifyIfTerminal(task, { logger = console } = {}) {
  if (!isTerminal(task)) {
    return { emitted: false, reason: 'not_terminal' };
  }

  if (task.notifiedAt && task.notifiedStatus === task.status) {
    return { emitted: false, reason: 'already_notified' };
  }

  const emittedAt = new Date().toISOString();
  const payload = buildPayload(task, emittedAt);

  const url = config.get('notificationWebhookUrl');
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

  const stored = await notificationStore.add({ ...payload, delivery });

  const updatedTask = await taskStore.updateExecution(task.id, {
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
  _buildPayload: buildPayload,
  _isTerminal: isTerminal,
};
