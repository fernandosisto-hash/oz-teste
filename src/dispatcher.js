const crypto = require('crypto');
const taskStore = require('./store/taskStore');
const ozClient = require('./ozClient');
const { mapOzState } = require('./ozStateMap');
const notificationService = require('./notificationService');

const VALID_MODES = ['local', 'webhook', 'oz'];

function newRunId() {
  return crypto.randomUUID();
}

function defaultMode(task) {
  if (task && task.executionMode) return task.executionMode;
  return ozClient.isConfigured() ? 'oz' : 'local';
}

async function runLocal(task) {
  return {
    ok: true,
    terminal: true,
    status: 'done',
    runId: newRunId(),
    detail: `local execution of task ${task.id}`,
  };
}

async function runWebhook(task) {
  const url = process.env.DISPATCH_WEBHOOK_URL;
  if (!url) {
    return {
      ok: false,
      terminal: true,
      status: 'failed',
      runId: newRunId(),
      error: 'DISPATCH_WEBHOOK_URL is not configured',
    };
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task }),
    });
    if (!res.ok) {
      return {
        ok: false,
        terminal: true,
        status: 'failed',
        runId: newRunId(),
        error: `webhook responded with HTTP ${res.status}`,
      };
    }
    return {
      ok: true,
      terminal: true,
      status: 'done',
      runId: newRunId(),
      detail: `webhook accepted task ${task.id}`,
    };
  } catch (err) {
    return {
      ok: false,
      terminal: true,
      status: 'failed',
      runId: newRunId(),
      error: `webhook request failed: ${err.message}`,
    };
  }
}

function buildOzPrompt(task) {
  const parts = [];
  if (task.title) parts.push(task.title.trim());
  if (task.description) parts.push(String(task.description).trim());
  return parts.join('\n\n') || `Task #${task.id}`;
}

async function runOz(task) {
  let created;
  try {
    created = await ozClient.createRun({
      prompt: buildOzPrompt(task),
      name: `task-${task.id}`,
    });
  } catch (err) {
    return {
      ok: false,
      terminal: true,
      status: 'failed',
      runId: null,
      sessionLink: null,
      runState: null,
      error: `oz createRun failed: ${err.message}`,
    };
  }

  await taskStore.updateExecution(task.id, {
    runId: created.runId,
    sessionLink: created.sessionLink,
    runState: created.runState,
  });

  const POLL_MAX_ATTEMPTS = 3;
  const POLL_INTERVAL_MS = 1500;
  let latest = created;

  for (let i = 0; i < POLL_MAX_ATTEMPTS; i += 1) {
    const mapped = mapOzState(latest.runState);
    if (mapped !== 'in_progress') break;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    try {
      latest = await ozClient.getRun(created.runId);
    } catch (err) {
      return {
        ok: true,
        terminal: false,
        status: 'in_progress',
        runId: created.runId,
        sessionLink: created.sessionLink,
        runState: created.runState,
        pollError: `oz getRun failed: ${err.message}`,
      };
    }
  }

  const finalStatus = mapOzState(latest.runState);
  const isTerminal = finalStatus !== 'in_progress';
  return {
    ok: finalStatus !== 'failed',
    terminal: isTerminal,
    status: finalStatus,
    runId: latest.runId || created.runId,
    sessionLink: latest.sessionLink || created.sessionLink,
    runState: latest.runState || created.runState,
    error: finalStatus === 'failed' ? `oz run reported state ${latest.runState}` : null,
  };
}

async function execute(task, mode) {
  if (mode === 'webhook') return runWebhook(task);
  if (mode === 'oz') return runOz(task);
  return runLocal(task);
}

async function dispatch(task, { mode } = {}) {
  const dispatchMode = mode || defaultMode(task);
  if (!VALID_MODES.includes(dispatchMode)) {
    const err = new Error(
      `invalid dispatch mode '${dispatchMode}', expected one of: ${VALID_MODES.join(', ')}`,
    );
    err.code = 'INVALID_MODE';
    throw err;
  }

  const dispatchedAt = new Date().toISOString();

  await taskStore.updateExecution(task.id, {
    status: 'in_progress',
    dispatchedAt,
    dispatchMode,
    runId: null,
    sessionLink: null,
    runState: null,
    completedAt: null,
    finishedAt: null,
    resultSummary: null,
    lastError: null,
    timedOut: false,
    cancelledAt: null,
  });

  const result = await execute(task, dispatchMode);
  const completedAt = result.terminal ? new Date().toISOString() : null;

  const patch = {
    status: result.status,
    runId: result.runId || null,
    sessionLink: result.sessionLink || null,
    runState: result.runState || null,
    completedAt,
    finishedAt: completedAt,
    lastError: result.error || result.pollError || null,
  };

  const updated = await taskStore.updateExecution(task.id, patch);

  if (result.terminal) {
    await notificationService.notifyIfTerminal(updated);
    return (await taskStore.getById(task.id)) || updated;
  }

  return updated;
}

module.exports = {
  dispatch,
  VALID_MODES,
  _defaultMode: defaultMode,
  _execute: execute,
};
