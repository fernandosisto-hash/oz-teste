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
## Persistence
Tasks are persisted to a local JSON file so they survive server restarts.
- Default location: `data/tasks.json` (relative to the repo root).
- Override with the `TASKS_DATA_FILE` environment variable.
- The `data/` directory is created on first write and is ignored by git.
- On first run, the file is initialized empty; if the file is missing on a
  later run it is re-created empty. A corrupt file causes startup to fail
  loudly rather than silently dropping data.
No database is used; the file is rewritten on every mutation.
## Project layout
```
src/
  index.js           # entry point, starts the HTTP server + auto-sync loop
  app.js             # Express app configuration
  dispatcher.js      # task orchestration (local + webhook + oz modes)
  syncService.js     # auto-sync loop + single-task/bulk sync helpers
  ozStateMap.js      # shared Warp Oz run-state -> task-status mapping
  ozClient.js        # thin Warp Oz REST API client (createRun/getRun)
  routes/
    index.js         # mounts all feature routers
    health.js        # GET /health
    info.js          # GET /info
    tasks.js         # tasks endpoints incl. dispatch + sync
  store/
    taskStore.js     # file-backed JSON persistence for tasks
test/
  autoSync.test.js   # integration test: dispatch + auto-sync vs mock Oz
data/
  tasks.json         # runtime task data (gitignored)
```
