const config = require('./config');
const ozClient = require('./ozClient');

const DIRECT_MODES = ['local', 'webhook', 'oz'];
const VALID_MODES = ['local', 'webhook', 'oz', 'miguel'];

function isValidMode(mode) {
  return VALID_MODES.includes(mode);
}

function describeAvailability() {
  const webhookUrl = config.get('dispatchWebhookUrl');
  const localFallback = config.get('miguelLocalFallback');
  const ozConfigured = ozClient.isConfigured();

  return {
    oz: {
      available: ozConfigured,
      reason: ozConfigured ? 'warp_api_key_configured' : 'warp_api_key_missing',
    },
    webhook: {
      available: Boolean(webhookUrl),
      reason: webhookUrl
        ? 'dispatch_webhook_url_configured'
        : 'dispatch_webhook_url_missing',
    },
    local: {
      available: localFallback,
      reason: localFallback
        ? 'miguel_local_fallback_enabled'
        : 'miguel_local_fallback_disabled',
    },
  };
}

function defaultRequestedMode(task) {
  if (task && task.executionMode) return task.executionMode;
  return config.get('defaultExecutionMode');
}

function buildMiguelCandidates() {
  const order = config.get('miguelDispatchOrder');
  const availability = describeAvailability();
  return order.map((mode) => ({
    mode,
    available: Boolean(availability[mode] && availability[mode].available),
    reason: availability[mode] && availability[mode].reason,
  }));
}

function resolvePlan({ task, mode } = {}) {
  const requestedMode = mode || defaultRequestedMode(task);
  const selectedBy = mode
    ? 'request.mode'
    : task && task.executionMode
      ? 'task.executionMode'
      : 'config.defaultExecutionMode';

  if (!isValidMode(requestedMode)) {
    const err = new Error(
      `invalid dispatch mode '${requestedMode}', expected one of: ${VALID_MODES.join(', ')}`,
    );
    err.code = 'INVALID_MODE';
    throw err;
  }

  if (DIRECT_MODES.includes(requestedMode)) {
    return {
      requestedMode,
      dispatchMode: requestedMode,
      meta: {
        orchestrator: 'direct',
        requestedMode,
        resolvedMode: requestedMode,
        selectedBy,
        route: [requestedMode],
        fallbackUsed: false,
        reason: 'direct dispatch mode requested',
        availability: describeAvailability(),
        candidates: [{ mode: requestedMode, available: true, reason: 'selected_directly' }],
      },
    };
  }

  const candidates = buildMiguelCandidates();
  const selected = candidates.find((candidate) => candidate.available);

  return {
    requestedMode,
    dispatchMode: selected ? selected.mode : null,
    meta: {
      orchestrator: 'miguel',
      requestedMode,
      resolvedMode: selected ? selected.mode : null,
      selectedBy,
      route: candidates.map((candidate) => candidate.mode),
      fallbackUsed: Boolean(selected && candidates[0] && selected.mode !== candidates[0].mode),
      reason: selected
        ? `selected first available mode '${selected.mode}' from MIGUEL_DISPATCH_ORDER`
        : 'no available dispatch mode matched MIGUEL_DISPATCH_ORDER',
      availability: describeAvailability(),
      candidates,
    },
  };
}

function runtimeSummary() {
  const defaultMode = config.get('defaultExecutionMode');
  const plan = resolvePlan({ task: null, mode: defaultMode });
  return {
    validModes: VALID_MODES.slice(),
    directModes: DIRECT_MODES.slice(),
    defaultExecutionMode: defaultMode,
    resolvedDefaultMode: plan.dispatchMode,
    miguel: {
      order: config.get('miguelDispatchOrder'),
      localFallback: config.get('miguelLocalFallback'),
      availability: describeAvailability(),
    },
  };
}

module.exports = {
  DIRECT_MODES,
  VALID_MODES,
  isValidMode,
  describeAvailability,
  resolvePlan,
  runtimeSummary,
};
