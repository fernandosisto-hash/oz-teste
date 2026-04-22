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
- `POST /tasks/:id/dispatch` — dispatch a task through the orchestrator; optional body: `{ "mode": "local|webhook|oz" }`. Moves the task to `in_progress` and records `runId`, `sessionLink`, `dispatchedAt`, `dispatchMode`, `runState`, `completedAt` and (on failure) `lastError`. Terminal state (`done`/`failed`/`cancelled`) is set when the underlying run completes.
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
### Current limitations
- The dispatcher only polls the Oz run briefly inside the HTTP call.
  Long-running runs are left as `in_progress`; there is no background
  reconciliation yet. Use `GET /tasks/:id` or the stored `sessionLink`
  to check final state in Warp.
- No queue/worker: dispatch is synchronous from the caller's point of
  view and one task is dispatched per HTTP request.
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
  index.js           # entry point, starts the HTTP server
  app.js             # Express app configuration
  dispatcher.js      # task orchestration (local + webhook + oz modes)
  ozClient.js        # thin Warp Oz REST API client (createRun/getRun)
  routes/
    index.js         # mounts all feature routers
    health.js        # GET /health
    info.js          # GET /info
    tasks.js         # tasks endpoints incl. POST /tasks/:id/dispatch
  store/
    taskStore.js     # file-backed JSON persistence for tasks
data/
  tasks.json         # runtime task data (gitignored)
```
