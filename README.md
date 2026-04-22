# oz-teste
Node.js + Express API skeleton with a first-pass Warp Oz task dispatcher.
## Requirements
- Node.js >= 18
## Install
```bash
npm install
```
## Run
```bash
npm start     # start the server
npm run dev   # start with nodemon reload
npm test      # run tests
npm run lint  # run linter
```
The server listens on `PORT` (default `3000`).
## Endpoints
- `GET /health` — liveness probe, returns `{ "status": "ok" }`.
- `GET /info` — returns package metadata, Node.js version and process uptime.
- `POST /tasks` — intake a new task; body: `{ "title": "string", "description": "string", "executionMode": "local|webhook|oz" }`. New tasks start in status `received`.
- `GET /tasks` — list all tasks.
- `GET /tasks/:id` — get a single task by id.
- `PATCH /tasks/:id/status` — update task status; body: `{ "status": "pending|received|in_progress|done|failed|cancelled" }`.
- `POST /tasks/:id/dispatch` — dispatch a task through the orchestrator; optional body: `{ "mode": "local|webhook|oz" }`. Moves the task to `in_progress` and records `runId`, `sessionLink`, `dispatchedAt`, `dispatchMode`, `runState`, `completedAt`, `finishedAt`, `resultSummary` and (on failure) `lastError`. Terminal state (`done`/`failed`/`cancelled`) is set when the underlying run completes (or when auto-sync catches up, see below).
- `POST /tasks/:id/sync` — force a single sync of a task against its Oz run. Returns the updated task. `409` if the task has no `runId` or is not an `oz`-dispatched task; `404` if the id is unknown. Already-terminal tasks are returned as-is.
- `POST /tasks/sync` — reconcile every in-progress Oz task in one pass. Returns `{ synced, results[] }`. Useful to manually advance pending tasks without waiting for the next auto-sync tick.
- `GET /notifications` — list every terminal-state notification event that has been emitted. Optional query param `taskId` filters by task. Returns `{ notifications, total }`.
- `GET /tasks/:id/notifications` — list the terminal-state notification events emitted for a specific task.
## Dispatch
Dispatch modes:
- `oz` (default when `WARP_API_KEY` is set): creates a **real Warp Oz
  cloud agent run** via the REST API (`POST /api/v1/agent/run`). The
  task is persisted in `in_progress` with `runId`, `sessionLink` and
  the current `runState`. The dispatcher then briefly polls the run
  (a few short attempts) and, if it completes quickly, transitions the
  task to `done`/`failed`/`cancelled`. Long-running Oz runs stay
  `in_progress` with the Warp `sessionLink` stored so an operator can
  follow the run in Warp.
- `local` (default when `WARP_API_KEY` is not set): deterministic no-op
  execution — the task is immediately marked `done`. Useful as a
  zero-config fallback / dev mode.
- `webhook`: POSTs the task payload to `DISPATCH_WEBHOOK_URL`. A 2xx
  response marks the task `done`; any other response or network error
  marks it `failed` and stores the reason in `lastError`.
### Environment variables
Configure external integrations with environment variables (no secrets
in source):
- `WARP_API_KEY` — **required for `oz` mode.** Bearer token for the
  Warp REST API. Create one in Warp Settings → Platform.
- `OZ_ENVIRONMENT_ID` — optional. The Warp cloud environment ID to run
  the Oz agent in. If unset, the account default is used.
- `WARP_API_BASE` — optional. Override the Warp API base URL
  (default `https://app.warp.dev`). Useful for testing.
- `DISPATCH_WEBHOOK_URL` — required for `webhook` mode.
Example:
```bash
export WARP_API_KEY=wk-...
export OZ_ENVIRONMENT_ID=pLTnDripE1BVfLpDxBrKQJ   # optional
npm start
```
## Automatic sync
After dispatch, long-running Oz runs are driven to a terminal state
automatically — there is no human in the loop.
A small in-process timer (`src/syncService.js`) wakes up every
`AUTO_SYNC_INTERVAL_MS` milliseconds (default `5000`), finds every
task that is `in_progress` (or `pending`) with a `runId` and a
`dispatchMode` of `oz`, calls `GET /api/v1/agent/runs/:runId` against
the Warp API, and persists the result on the task:
- `runState` (raw Warp state string)
- `status` (mapped to `in_progress` / `done` / `failed` / `cancelled`)
- `sessionLink` (kept fresh from the API)
- `resultSummary` (best-effort, from `result_summary` / `summary` /
  `result` fields if present in the payload)
- `completedAt` and `finishedAt` (set the first time the task reaches
  a terminal state)
- `lastError` (set on `failed` or on a transient Oz API error; cleared
  on successful completion)
Terminal tasks are skipped on subsequent ticks, so the loop naturally
quiets down once everything has resolved.
### Controls
- `AUTO_SYNC_INTERVAL_MS` — override the tick interval in milliseconds
  (minimum 500, default 5000).
- `AUTO_SYNC_DISABLED=true` — do not start the loop at all. Useful in
  tests or when driving sync manually via the HTTP endpoints.
### Manual triggers
- `POST /tasks/:id/sync` — sync a single task immediately.
- `POST /tasks/sync` — reconcile every active Oz task in one pass.
### Current limitations
- Auto-sync runs only in-process, in the same Node.js server that
  receives the dispatch. Restarting the server resumes the loop from
  persisted state (so in-progress tasks are picked back up on next
  tick), but there is no cross-process coordination: running two
  servers against the same `tasks.json` would duplicate sync calls.
- No queue/worker pool; the loop is sequential on purpose.
- Non-`oz` dispatch modes (`local`, `webhook`) are driven to terminal
  synchronously during dispatch and are never touched by auto-sync.
- No auth on the API, no database, no Docker/CI/deploy config.
- Re-dispatching a task that is already `in_progress` is rejected; set
  the task to `failed` via `PATCH /tasks/:id/status` if you need to
  retry an Oz run.
## Terminal-state notifications
When a task reaches a terminal state (`done`, `failed`, or
`cancelled`) — whether via fast dispatch (`local` / `webhook` /
quick-finishing `oz`) or via a later auto-sync tick — the app emits a
single notification event describing the outcome. Two delivery paths
are offered in parallel:
1. **Persistent audit store** (always on). Events are appended to
   `data/notifications.json` and exposed via:
   - `GET /notifications` (optionally filtered by `?taskId=<id>`)
   - `GET /tasks/:id/notifications`
   This is the pull-based consumer path and the source of truth.
2. **Outbound webhook** (optional). If `NOTIFICATION_WEBHOOK_URL` is
   set, the event is POSTed as JSON to that URL. Delivery is
   best-effort: a non-2xx or network error is recorded on the
   persisted event under `delivery` and does **not** roll the task
   back to a non-terminal state or throw from dispatch/sync.
### Payload shape
```json
{
  "event": "task.terminal",
  "notificationId": "<uuid>",
  "taskId": 42,
  "status": "done",
  "runId": "run-...",
  "sessionLink": "https://app.warp.dev/session/...",
  "resultSummary": "...",
  "lastError": null,
  "finishedAt": "2025-01-01T00:00:00.000Z",
  "completedAt": "2025-01-01T00:00:00.000Z",
  "dispatchMode": "oz",
  "emittedAt": "2025-01-01T00:00:01.000Z"
}
```
The persisted store additionally wraps each event with a `delivery`
object recording whether the webhook POST was attempted and its
outcome (HTTP status or error).
### Duplicate protection
Each task records `notifiedAt` + `notifiedStatus` the first time a
terminal notification is emitted. Subsequent sync / poll cycles that
observe the same terminal status short-circuit without re-emitting,
so repeated manual `POST /tasks/:id/sync` calls or the background
auto-sync timer cannot produce duplicate events for the same outcome.
### Configuration
- `NOTIFICATION_WEBHOOK_URL` — optional. If set, each terminal-state
  event is POSTed here as JSON. Configure with an environment variable
  (no secrets in source).
- `NOTIFICATIONS_DATA_FILE` — optional. Override the path of the event
  audit store (default `data/notifications.json`).
### Current limitations (notifications)
- Webhook delivery is synchronous and single-attempt: no retries, no
  backoff, no queue. A flaky endpoint will record `delivery.ok=false`
  on the persisted event; the persisted store is the recovery path.
- No signing/HMAC on the webhook payload yet.
- Only `task.terminal` is emitted. Lifecycle events for
  `received` / `in_progress` are not published.
## Persistence
Tasks are persisted to a local JSON file so they survive server restarts.
- Default location: `data/tasks.json` (relative to the repo root).
- Override with the `TASKS_DATA_FILE` environment variable.
- The `data/` directory is created on first write and is ignored by git.
- On first run, the file is initialized empty; if the file is missing on a
  later run it is re-created empty. A corrupt file causes startup to fail
  loudly rather than silently dropping data.
Notification events are persisted alongside tasks in
`data/notifications.json` (override via `NOTIFICATIONS_DATA_FILE`).
No database is used; the file is rewritten on every mutation.
## Project layout
```
src/
  index.js                 # entry point, starts the HTTP server + auto-sync loop
  app.js                   # Express app configuration
  dispatcher.js            # task orchestration (local + webhook + oz modes)
  syncService.js           # auto-sync loop + single-task/bulk sync helpers
  notificationService.js   # terminal-state notification emit + webhook delivery
  ozStateMap.js            # shared Warp Oz run-state -> task-status mapping
  ozClient.js              # thin Warp Oz REST API client (createRun/getRun)
  routes/
    index.js               # mounts all feature routers
    health.js              # GET /health
    info.js                # GET /info
    tasks.js               # tasks endpoints incl. dispatch + sync
    notifications.js       # GET /notifications
  store/
    taskStore.js           # file-backed JSON persistence for tasks
    notificationStore.js   # file-backed JSON persistence for notification events
test/
  autoSync.test.js         # integration test: dispatch + auto-sync vs mock Oz
  notifications.test.js    # integration test: terminal-state notifications
data/
  tasks.json               # runtime task data (gitignored)
  notifications.json       # runtime notification audit trail (gitignored)
```
