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
- `POST /tasks` — intake a new task; body: `{ "title": "string", "description": "string" }`.
- `GET /tasks` — list all tasks.
- `GET /tasks/:id` — get a single task by id.
- `PATCH /tasks/:id/status` — update task status; body: `{ "status": "pending|in_progress|done|cancelled" }`.
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
  routes/
    index.js         # mounts all feature routers
    health.js        # GET /health
    info.js          # GET /info
    tasks.js         # POST /tasks, GET /tasks, GET /tasks/:id, PATCH /tasks/:id/status
  store/
    taskStore.js     # file-backed JSON persistence for tasks
data/
  tasks.json         # runtime task data (gitignored)
```
