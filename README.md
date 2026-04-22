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
## Project layout
```
src/
  index.js        # entry point, starts the HTTP server
  app.js          # Express app configuration
  routes/
    index.js      # mounts all feature routers
    health.js     # GET /health
    info.js       # GET /info
    tasks.js      # POST /tasks, GET /tasks
```
