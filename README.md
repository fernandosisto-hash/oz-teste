# oz-teste
Node.js + Express API skeleton.
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
- `POST /tasks` — intake a new task; body: `{ "title": "string", "description": "string", "executionMode": "local|webhook" }`. New tasks start in status `received`.
- `GET /tasks` — list all tasks.
- `GET /tasks/:id` — get a single task by id.
- `PATCH /tasks/:id/status` — update task status; body: `{ "status": "pending|received|in_progress|done|failed|cancelled" }`.
- `POST /tasks/:id/dispatch` — dispatch a task through the orchestrator; optional body: `{ "mode": "local|webhook" }`. Moves the task through `in_progress` and then to `done` or `failed`, recording `runId`, `dispatchedAt`, `dispatchMode`, `completedAt` and (on failure) `lastError`.
## Dispatch
Dispatch modes:
- `local` (default): deterministic no-op execution — the task is
  immediately marked `done`. Useful as a first-pass orchestrator.
- `webhook`: POSTs the task payload to `DISPATCH_WEBHOOK_URL`. A 2xx
  response marks the task `done`; any other response or network error
  marks it `failed` and stores the reason in `lastError`.
Configure external integrations with environment variables (no secrets
in source). Example:
```bash
DISPATCH_WEBHOOK_URL=https://example.com/hooks/oz npm start
```
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
  dispatcher.js      # task orchestration (local + webhook execution modes)
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
