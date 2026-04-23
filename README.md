# oz-teste
Node.js + Express API skeleton with a first-pass Warp Oz task dispatcher.
## Requirements
- Node.js >= 18
## Install
```bash
npm install
```
Copy `.env.example` to `.env` (or export env vars directly) before the
first non-trivial run.
## Run
```bash
npm start     # start the server
npm run dev   # start with nodemon reload
npm test      # run tests
npm run lint  # run linter
```
The server listens on `PORT` (default `3000`).
## Endpoints
- `GET /health` — liveness/readiness probe plus runtime snapshot. Returns `status`, `checks.storage`, `env`, and `dispatch`. Responds `200` when healthy or `503` when the selected storage backend is degraded. **Open** (never auth-gated).
- `GET /info` — returns package metadata, Node.js version, process uptime, env summary, runtime checks, and dispatch summary. **Open** (never auth-gated).
- `POST /tasks` — intake a new task; body: `{ "title": "string", "description": "string", "executionMode": "local|webhook|oz|miguel", "priority": "low|normal|high", "timeoutMs": number, "maxRetries": number }`. New tasks start in status `received`. `priority`, `timeoutMs` and `maxRetries` are optional (see [Operational governance](#operational-governance)). `executionMode` now defaults from `DEFAULT_EXECUTION_MODE` (falling back to `oz` when `WARP_API_KEY` is set, otherwise `local`). **Protected** when `API_TOKEN` is set.
- `GET /tasks` — list all tasks.
- `GET /tasks/:id` — get a single task by id.
- `PATCH /tasks/:id/status` — update task status; body: `{ "status": "pending|received|in_progress|done|failed|cancelled" }`. Invalid transitions (e.g. `done` → anything, `failed` → `done`) return `409`.
- `POST /tasks/:id/dispatch` — dispatch a task through the orchestrator; optional body: `{ "mode": "local|webhook|oz|miguel" }`. Moves the task to `in_progress` and records `runId`, `sessionLink`, `dispatchedAt`, `dispatchMode`, `runState`, `completedAt`, `finishedAt`, `resultSummary`, `dispatchMeta` and (on failure) `lastError`. Terminal state (`done`/`failed`/`cancelled`) is set when the underlying run completes (or when auto-sync catches up, see below).
- `POST /tasks/:id/cancel` — locally mark a task `cancelled` and emit a terminal notification. Valid from `received`, `pending`, or `in_progress`; returns `409` if the task is already in a terminal state. **Local cancel only** — the remote Oz run is NOT aborted; see [Operational governance](#operational-governance).
- `POST /tasks/:id/retry` — re-dispatch a task that is in `failed` status. Optional body: `{ "mode": "local|webhook|oz|miguel" }`. Increments `retryCount` and fires a fresh terminal notification when the new cycle completes. Returns `409` if the task is not `failed` or the retry budget has been exhausted.
- `POST /tasks/:id/sync` — force a single sync of a task against its Oz run. Returns the updated task. `409` if the task has no `runId` or is not an `oz`-dispatched task; `404` if the id is unknown. Already-terminal tasks are returned as-is.
- `POST /tasks/sync` — reconcile every in-progress Oz task in one pass, visiting higher-priority tasks first. Returns `{ synced, results[] }`. Useful to manually advance pending tasks without waiting for the next auto-sync tick.
- `GET /notifications` — list every terminal-state notification event that has been emitted. Optional query param `taskId` filters by task. Returns `{ notifications, total }`. **Protected** when `API_TOKEN` is set.
- `GET /tasks/:id/notifications` — list the terminal-state notification events emitted for a specific task. **Protected** when `API_TOKEN` is set.

All `/tasks` and `/notifications` routes — including `POST /tasks`, `GET /tasks`, `GET /tasks/:id`, `PATCH /tasks/:id/status`, `POST /tasks/:id/dispatch`, `POST /tasks/:id/cancel`, `POST /tasks/:id/retry`, `POST /tasks/:id/sync`, `POST /tasks/sync`, `GET /tasks/:id/notifications` and `GET /notifications` — are behind the same shared-secret check. See [API authentication](#api-authentication).
## API authentication
The orchestration API supports a minimal shared-secret auth layer.
- Set `API_TOKEN` to any non-empty string to require the token on every protected route.
- Callers send the token via either header:
  - `Authorization: Bearer <token>`
  - `X-API-Token: <token>`
- Missing credentials return `401 { "error": "authentication required" }`.
- Wrong credentials return `403 { "error": "invalid token" }`.
- `GET /health` and `GET /info` are always open so liveness probes and basic introspection keep working without a token.
- If `API_TOKEN` is **unset**, the middleware logs a one-time startup warning and lets every request through. This is intentional for zero-config local development; set `API_TOKEN` in any non-dev environment.
Example:
```bash
export API_TOKEN=$(openssl rand -hex 32)
npm start
# in another shell:
curl -s http://localhost:3000/health                       # 200 (open)
curl -s http://localhost:3000/tasks                        # 401
curl -s -H "Authorization: Bearer $API_TOKEN" \
  http://localhost:3000/tasks                              # 200
curl -s -X POST -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"hello","executionMode":"local"}' \
  http://localhost:3000/tasks                              # 201
```
Token comparison uses `crypto.timingSafeEqual` to avoid trivial timing side-channels. Never hardcode the token — always provide it via the environment.
## Dispatch
Dispatch modes:
- `miguel`: a small orchestration layer that evaluates `MIGUEL_DISPATCH_ORDER`
  and chooses the first currently available target among `local`,
  `webhook`, and `oz`. The decision is persisted on the task in
  `dispatchMeta` (`requestedMode`, `resolvedMode`, `route`,
  `availability`, `fallbackUsed`, `reason`) and is also surfaced by
  `GET /health` and `GET /info`. If no target is available, the task is
  failed with audit metadata instead of silently guessing.
- `oz` (default when `WARP_API_KEY` is set unless `DEFAULT_EXECUTION_MODE` overrides it): creates a **real Warp Oz
  cloud agent run** via the REST API (`POST /api/v1/agent/run`). The
  task is persisted in `in_progress` with `runId`, `sessionLink` and
  the current `runState`. The dispatcher then briefly polls the run
  (a few short attempts) and, if it completes quickly, transitions the
  task to `done`/`failed`/`cancelled`. Long-running Oz runs stay
  `in_progress` with the Warp `sessionLink` stored so an operator can
  follow the run in Warp.
- `local` (default when neither `DEFAULT_EXECUTION_MODE` nor `WARP_API_KEY` selects something else): deterministic no-op
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
- `DEFAULT_EXECUTION_MODE` — optional. One of `local`, `webhook`, `oz`,
  `miguel`. Applies when task creation omits `executionMode`.
- `MIGUEL_DISPATCH_ORDER` — optional. Comma-separated target order used
  by `miguel` mode. Allowed values: `local`, `webhook`, `oz`.
  Default: `oz,webhook,local`.
- `MIGUEL_LOCAL_FALLBACK` — optional boolean (default `true`). When
  `false`, `miguel` treats the local executor as unavailable and can
  fail closed if no remote target is ready.
Example:
```bash
export WARP_API_KEY=wk-...
export DEFAULT_EXECUTION_MODE=miguel
export MIGUEL_DISPATCH_ORDER=oz,webhook,local
export OZ_ENVIRONMENT_ID=pLTnDripE1BVfLpDxBrKQJ   # optional
npm start
```
## Operational governance
Tasks carry a small amount of operational metadata so callers can
prioritize work, bound how long a task may run, and recover from
transient failures without losing audit trail.
### Priority
- Field: `priority`. Allowed values: `low`, `normal`, `high`.
- Default: `normal`.
- Effect: `POST /tasks/sync` and the background auto-sync loop visit
  higher-priority tasks before lower-priority ones; within the same
  priority bucket, older tasks (`createdAt` ascending) go first.
- Priority does NOT pre-empt an already-running task; it only
  influences the order in which the next reconciliation pass picks
  candidates.
### Timeout
- Field: `timeoutMs`. A positive integer number of milliseconds, or
  `null` for no timeout.
- Bounds: must be between `1000` ms and `86400000` ms (24 h) when
  explicitly provided. Invalid values return `400`.
- Default: read from `TASK_DEFAULT_TIMEOUT_MS` at task-creation time
  (unset → no timeout).
- Enforcement: on every sync call (manual or auto-sync), a task whose
  `dispatchedAt + timeoutMs < now` is marked `failed` with
  `timedOut: true` and `lastError = "task timed out after <ms>ms"`.
  A terminal notification is emitted. The remote Oz run is NOT
  aborted — only our local record transitions to terminal.
### Retry
- Field: `retryCount` (read-only, starts at `0`).
- Field: `maxRetries`. Per-task override; if `null` or omitted, the
  global default `MAX_TASK_RETRIES` is used (default `3`).
- Retries are triggered explicitly via `POST /tasks/:id/retry`.
  The endpoint:
  - Requires the task to be in `failed` status (else `409`).
  - Enforces the effective `maxRetries` budget (else `409`).
  - Increments `retryCount`, clears `lastError` / `timedOut` /
    `notifiedAt` / `notifiedStatus`, resets status to `received`, and
    dispatches through the orchestrator.
  - A fresh terminal notification is emitted when the new cycle
    finishes.
- There is no automatic retry and no exponential backoff; the caller
  decides when to retry.
### Cancel
- `POST /tasks/:id/cancel` transitions a non-terminal task to
  `cancelled`, stamps `cancelledAt` / `finishedAt`, and emits a
  terminal notification.
- Cancelling a task already in `done` / `failed` / `cancelled` returns
  `409`.
- **Local only.** If the task had already been dispatched to a remote
  Oz run, that run is NOT aborted — the operator can follow
  `sessionLink` to inspect / stop it in Warp. Future sync ticks will
  simply skip the task because it is now terminal.
### Status transitions
Protected transitions are enforced by `PATCH /tasks/:id/status`:
- `received` → `in_progress` / `cancelled` / `failed`
- `in_progress` → `done` / `failed` / `cancelled`
- `failed` → `received` / `in_progress` (retry path)
- `done` and `cancelled` are permanently terminal
Any other requested transition returns `409 { "error": "invalid transition: ..." }`.
### Configuration
- `TASK_DEFAULT_TIMEOUT_MS` — optional. Default timeout (ms) applied
  to tasks created without an explicit `timeoutMs`. Clamped to the
  `[1000, 86400000]` range.
- `MAX_TASK_RETRIES` — optional. Default retry budget for tasks that
  do not specify their own `maxRetries`. Non-negative integer;
  defaults to `3`.
- `DATA_DIR` — optional. Base directory for the local JSON stores
  when `TASKS_DATA_FILE` / `NOTIFICATIONS_DATA_FILE` are not set.
- `STORE_BACKUP_LIMIT` — optional. How many rotating backup copies to
  keep for each JSON store. Default `3`. Set `0` to disable backups.
- `DEFAULT_EXECUTION_MODE` — optional. Default `executionMode` applied
  during task creation.
- `MIGUEL_DISPATCH_ORDER` — optional. Target order evaluated by
  `executionMode=miguel`.
- `MIGUEL_LOCAL_FALLBACK` — optional. Enables/disables local fallback
  inside `miguel` mode.
### Limits
- Cancellation and timeouts are local only; they do not abort a
  remote Oz run.
- No pre-emption: priority reorders pending work, it does not
  interrupt running work.
- No retry backoff or automatic retry — retries are always explicit.
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
- Optional shared-secret auth via `API_TOKEN`; no full user system, database, OAuth, JWT infrastructure, or Docker/CI/deploy config.
- Persistence is still file-based JSON, but writes are now atomic and each save keeps rotating backup files (`.bak.1`, `.bak.2`, ...), which reduces the risk of losing all state on a partial write or corruption.
- Re-dispatching a task that is already `in_progress` is rejected; set
  the task to `failed` via `PATCH /tasks/:id/status` if you need to
  retry an Oz run.
## Operational configuration
All environment variables are read through `src/config.js`. At boot,
`src/index.js` calls `config.validateForBoot()` and aborts the process
if any of the following rules fail:
- `NODE_ENV=production` requires `API_TOKEN` to be set (otherwise the
  protected routes would be open).
- `PORT` must be a valid TCP port.
- `LOG_LEVEL` must be one of `debug`, `info`, `warn`, `error`.
- `DEFAULT_EXECUTION_MODE`, when set, must be one of `local`,
  `webhook`, `oz`, `miguel`.
- `MIGUEL_DISPATCH_ORDER`, when set, must contain only `local`,
  `webhook`, `oz`.
Recognised variables (beyond the ones already listed above):
- `NODE_ENV` — `development` (default) or `production`. Controls the
  boot-time token enforcement and whether 500 responses include a
  `debug` field.
- `PORT` — TCP port (default `3000`).
- `LOG_LEVEL` — logger threshold (default `info`).
- `JSON_BODY_LIMIT` — max request body for `express.json` (default
  `100kb`). Exceeding it returns `413 { "error": "request body too
  large", "code": "PAYLOAD_TOO_LARGE" }`.
- `TRUST_PROXY` — when set, passed to `app.set('trust proxy', ...)` so
  `X-Forwarded-For` / `X-Forwarded-Proto` are honoured behind a
  reverse proxy. Leave unset locally.
## Errors
Unhandled errors and 404s go through a global handler
(`src/middleware/errorHandler.js`) that returns a stable shape:
```json
{ "error": "...", "code": "...", "details": { } }
```
- 4xx responses include the original message.
- 5xx responses are redacted to `"internal error"` (the full error is
  logged server-side with the request id). In non-production
  environments an extra `debug` field mirrors the message to speed up
  local debugging.
- Malformed JSON returns `400 { "code": "INVALID_JSON" }`.
- Oversized bodies return `413 { "code": "PAYLOAD_TOO_LARGE" }`.
## Logs
Structured JSON lines on stdout/stderr. Every HTTP request emits one
`http_request` record with `requestId`, `method`, `path`, `status`,
`durationMs`. The request id is also returned to the client in the
`X-Request-Id` response header, and an inbound `X-Request-Id` header
is honoured so end-to-end traces can be correlated across services.

Dispatch now also emits `dispatch_selected`, `dispatch_finished`, and
`dispatch_unresolved` records so the chosen target and fallback path are
observable without opening the task store by hand.

`GET /health` now performs a lightweight storage readiness check:
- `json` backend → verifies the tasks/notifications directories are readable+writable
- `postgres` backend → runs `SELECT 1`
## Graceful shutdown
On `SIGTERM` or `SIGINT`, `src/index.js` stops the auto-sync timer,
closes the HTTP server (draining in-flight requests), and exits. A
10-second watchdog ensures a stuck connection cannot block shutdown
indefinitely.
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
	orchestration.js         # miguel routing + dispatch availability summary
	dispatcher.js            # task orchestration (local + webhook + oz modes)
  syncService.js           # auto-sync loop + single-task/bulk sync helpers
  notificationService.js   # terminal-state notification emit + webhook delivery
  governance.js            # priority / timeout / retry / transition helpers
  ozStateMap.js            # shared Warp Oz run-state -> task-status mapping
  ozClient.js              # thin Warp Oz REST API client (createRun/getRun)
  middleware/
    auth.js                # API_TOKEN shared-secret auth middleware
  routes/
    index.js               # mounts all feature routers (auth on /tasks + /notifications)
    health.js              # GET /health (open)
    info.js                # GET /info (open)
    tasks.js               # tasks endpoints incl. dispatch + sync (protected)
    notifications.js       # GET /notifications (protected)
  store/
    taskStore.js           # file-backed JSON persistence for tasks
    notificationStore.js   # file-backed JSON persistence for notification events
test/
  autoSync.test.js         # integration test: dispatch + auto-sync vs mock Oz
  notifications.test.js    # integration test: terminal-state notifications
	auth.test.js             # integration test: API_TOKEN auth on protected routes
	governance.test.js       # integration test: priority, cancel, retry, timeout, transitions
	miguelDispatch.test.js   # integration test: miguel orchestration + health/info exposure
data/
  tasks.json               # runtime task data (gitignored)
  notifications.json       # runtime notification audit trail (gitignored)
```
