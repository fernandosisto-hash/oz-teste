/**
 * Shared mapping from Warp Oz run states to our internal task status
 * vocabulary. Extracted from the dispatcher so the sync service can
 * use it without creating a circular dependency.
 */

const OZ_STATE_MAP = {
  INPROGRESS: 'in_progress',
  IN_PROGRESS: 'in_progress',
  RUNNING: 'in_progress',
  STARTING: 'in_progress',
  QUEUED: 'in_progress',
  PENDING: 'in_progress',
  SUCCEEDED: 'done',
  COMPLETED: 'done',
  DONE: 'done',
  FAILED: 'failed',
  ERRORED: 'failed',
  CANCELLED: 'cancelled',
  CANCELED: 'cancelled',
};

function mapOzState(runState) {
  if (!runState) return 'in_progress';
  return OZ_STATE_MAP[String(runState).toUpperCase()] || 'in_progress';
}

module.exports = {
  OZ_STATE_MAP,
  mapOzState,
};
