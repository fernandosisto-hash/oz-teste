const app = require('./app');
const syncService = require('./syncService');

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);

  // Background reconciliation of in-progress Oz runs. Disabled by
  // setting AUTO_SYNC_DISABLED=true (e.g. in tests). Interval is
  // configurable via AUTO_SYNC_INTERVAL_MS.
  if (process.env.AUTO_SYNC_DISABLED === 'true') {
    console.log('[auto-sync] disabled via AUTO_SYNC_DISABLED=true');
    return;
  }
  const intervalMs = Number(process.env.AUTO_SYNC_INTERVAL_MS) || 5000;
  const started = syncService.startAutoSync({ intervalMs });
  if (started.started) {
    console.log(`[auto-sync] started (every ${started.intervalMs}ms)`);
  }
});
