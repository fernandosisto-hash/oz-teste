const db = require('./postgresClient');

function rowToNotification(row) {
  if (!row) return null;
  return {
    event: row.event,
    notificationId: row.notification_id,
    taskId: row.task_id,
    status: row.status,
    runId: row.run_id,
    sessionLink: row.session_link,
    resultSummary: row.result_summary,
    lastError: row.last_error,
    finishedAt: row.finished_at && row.finished_at.toISOString(),
    completedAt: row.completed_at && row.completed_at.toISOString(),
    dispatchMode: row.dispatch_mode,
    emittedAt: row.emitted_at && row.emitted_at.toISOString(),
    delivery: row.delivery || {},
  };
}

async function init() {
  await db.initSchema();
  return true;
}

async function getAll() {
  await init();
  const { rows } = await db.query(
    'SELECT * FROM notifications ORDER BY emitted_at DESC, notification_id DESC',
  );
  return rows.map(rowToNotification);
}

async function getByTaskId(taskId) {
  await init();
  const { rows } = await db.query(
    'SELECT * FROM notifications WHERE task_id = $1 ORDER BY emitted_at DESC, notification_id DESC',
    [Number(taskId)],
  );
  return rows.map(rowToNotification);
}

async function add(event) {
  await init();
  const { rows } = await db.query(
    `INSERT INTO notifications (
      notification_id, event, task_id, status, run_id, session_link,
      result_summary, last_error, finished_at, completed_at,
      dispatch_mode, emitted_at, delivery
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    RETURNING *`,
    [
      event.notificationId,
      event.event,
      event.taskId,
      event.status,
      event.runId || null,
      event.sessionLink || null,
      event.resultSummary || null,
      event.lastError || null,
      event.finishedAt || null,
      event.completedAt || null,
      event.dispatchMode || null,
      event.emittedAt,
      JSON.stringify(event.delivery || {}),
    ],
  );
  return rowToNotification(rows[0]);
}

module.exports = {
  init,
  getAll,
  getByTaskId,
  add,
  kind: 'postgres',
};
