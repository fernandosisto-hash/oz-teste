const db = require('./postgresClient');

function rowToTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    executionMode: row.execution_mode,
    status: row.status,
    priority: row.priority,
    timeoutMs: row.timeout_ms,
    retryCount: row.retry_count,
    maxRetries: row.max_retries,
    createdAt: row.created_at && row.created_at.toISOString(),
    updatedAt: row.updated_at && row.updated_at.toISOString(),
    dispatchMode: row.dispatch_mode,
    runId: row.run_id,
    sessionLink: row.session_link,
    runState: row.run_state,
    completedAt: row.completed_at && row.completed_at.toISOString(),
    finishedAt: row.finished_at && row.finished_at.toISOString(),
    resultSummary: row.result_summary,
    lastError: row.last_error,
    timedOut: row.timed_out,
    cancelledAt: row.cancelled_at && row.cancelled_at.toISOString(),
    notifiedAt: row.notified_at && row.notified_at.toISOString(),
    notifiedStatus: row.notified_status,
    dispatchedAt: row.dispatched_at && row.dispatched_at.toISOString(),
  };
}

const PATCH_COLUMN_MAP = {
  title: 'title',
  description: 'description',
  executionMode: 'execution_mode',
  status: 'status',
  priority: 'priority',
  timeoutMs: 'timeout_ms',
  retryCount: 'retry_count',
  maxRetries: 'max_retries',
  dispatchMode: 'dispatch_mode',
  runId: 'run_id',
  sessionLink: 'session_link',
  runState: 'run_state',
  completedAt: 'completed_at',
  finishedAt: 'finished_at',
  resultSummary: 'result_summary',
  lastError: 'last_error',
  timedOut: 'timed_out',
  cancelledAt: 'cancelled_at',
  notifiedAt: 'notified_at',
  notifiedStatus: 'notified_status',
  dispatchedAt: 'dispatched_at',
};

async function init() {
  await db.initSchema();
  return true;
}

async function getAll() {
  await init();
  const { rows } = await db.query('SELECT * FROM tasks ORDER BY id ASC');
  return rows.map(rowToTask);
}

async function getById(id) {
  await init();
  const { rows } = await db.query('SELECT * FROM tasks WHERE id = $1', [Number(id)]);
  return rowToTask(rows[0] || null);
}

async function add({
  title,
  description,
  executionMode,
  priority,
  timeoutMs,
  maxRetries,
}) {
  await init();
  const { rows } = await db.query(
    `INSERT INTO tasks (
      title, description, execution_mode, status, priority,
      timeout_ms, retry_count, max_retries, created_at, timed_out
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    RETURNING *`,
    [
      title,
      description || null,
      executionMode || 'local',
      'received',
      priority || 'normal',
      timeoutMs == null ? null : Number(timeoutMs),
      0,
      Number.isFinite(maxRetries) ? Number(maxRetries) : null,
      new Date().toISOString(),
      false,
    ],
  );
  return rowToTask(rows[0]);
}

async function updateStatus(id, status) {
  return updateExecution(id, { status });
}

async function updateExecution(id, patch) {
  await init();
  const keys = Object.keys(patch || {}).filter((key) => PATCH_COLUMN_MAP[key]);
  if (keys.length === 0) {
    return getById(id);
  }

  const assignments = [];
  const values = [];
  let index = 1;
  for (const key of keys) {
    assignments.push(`${PATCH_COLUMN_MAP[key]} = $${index}`);
    values.push(patch[key]);
    index += 1;
  }
  assignments.push(`updated_at = $${index}`);
  values.push(new Date().toISOString());
  values.push(Number(id));

  const { rows } = await db.query(
    `UPDATE tasks SET ${assignments.join(', ')} WHERE id = $${index + 1} RETURNING *`,
    values,
  );

  return rowToTask(rows[0] || null);
}

module.exports = {
  init,
  getAll,
  getById,
  add,
  updateStatus,
  updateExecution,
  kind: 'postgres',
};
