# nestjs-canonical-log example app

A minimal NestJS app that wires `nestjs-canonical-log` end-to-end and demonstrates the four shapes a canonical log line can take in production: success, success with domain state transitions, error from a controller, and error from validation.

## Run it

The example consumes `nestjs-canonical-log` as a locally-linked workspace package (`"nestjs-canonical-log": "workspace:*"`), so build the library first, then start the app:

```bash
# From the repo root — build the library into dist/
pnpm install
pnpm build

# Then run the example
cd example
pnpm start
```

The app listens on `http://localhost:3000` and prints a usage hint to stderr. Logs go to stdout, pretty-printed by `pino-pretty`.

> **Note on flatness:** the example sets `quietReqLogger: true` on `pino-http`. Without it, pino auto-attaches a nested `req: { method, url, headers, ... }` object to every log line inside a request scope, which would defeat the whole point of a canonical line being a flat, queryable record.

## What's wired up

```
src/
├── main.ts              — bootstrap, replaces Nest's default logger with pino
├── app.module.ts        — ClsModule → LoggerModule → CanonicalLogModule → AuthModule → JobsModule
├── auth/
│   ├── auth.module.ts   — auth middleware in its own module (see "ordering" below)
│   └── auth.middleware.ts — addFields({ actor_id }) — simulates resolving the principal
└── jobs/
    ├── jobs.module.ts
    ├── jobs.controller.ts — GET /jobs/:id, PATCH /jobs/:id/status
    └── jobs.service.ts    — addFields for job.id / job.status_from / job.status_to
```

### Module ordering

`ClsModule` opens the `AsyncLocalStorage` scope per request. Anything that calls `addFields()` needs that scope to be open.

NestJS runs middleware registered in `AppModule.configure()` **before** middleware from any imported module — including `ClsModule`. If `AuthMiddleware` were applied directly in `AppModule`, it would fire outside the CLS scope and silently lose its fields.

The example sidesteps this by putting auth in its own `AuthModule` imported *after* `ClsModule` and `CanonicalLogModule`. Middleware from imported modules runs in import order, so `AuthMiddleware` ends up safely inside the CLS scope.

## The four canonical lines

### 1. Success — `GET /jobs/:id`

```bash
curl http://localhost:3000/jobs/job-123
```

Response:
```json
{"id":"job-123","status":"scheduled","title":"Install HVAC Unit"}
```

Canonical line:
```
[01:18:03.429] INFO: canonical
    service.name: "example-api"
    deployment.environment: "development"
    http.request.method: "GET"
    http.route: "/jobs/:id"
    actor_id: "user-42"
    job.id: "job-123"
    http.response.status_code: 200
    duration_ms: 2.330168
    outcome: "ok"
```

`http.route` is the parameterised template (`/jobs/:id`), not the raw URL — so this groups cleanly across all job lookups in Datadog. `actor_id` comes from `AuthMiddleware`; `job.id` from `JobsService.findById`.

### 2. Success with state transition — `PATCH /jobs/:id/status`

```bash
curl -X PATCH http://localhost:3000/jobs/job-123/status \
  -H 'Content-Type: application/json' \
  -d '{"status":"in_progress"}'
```

Response:
```json
{"id":"job-123","status":"in_progress","title":"Install HVAC Unit"}
```

Canonical line:
```
[01:18:03.442] INFO: canonical
    service.name: "example-api"
    http.request.method: "PATCH"
    http.route: "/jobs/:id/status"
    actor_id: "user-42"
    job.id: "job-123"
    job.status_from: "scheduled"
    job.status_to: "in_progress"
    http.response.status_code: 200
    duration_ms: 0.418034
    outcome: "ok"
```

The service sets `job.status_from` *before* the write and `job.status_to` *after*. Both fields present = the transition completed. The query `"job.status_from:scheduled job.status_to:in_progress"` becomes a Datadog facet you can chart and alert on.

### 3. Controller error — `GET /jobs/not-found`

```bash
curl http://localhost:3000/jobs/not-found
```

Response:
```json
{"message":"Job not-found not found","error":"Not Found","statusCode":404}
```

Canonical line:
```
[01:18:03.450] INFO: canonical
    service.name: "example-api"
    http.request.method: "GET"
    http.route: "/jobs/:id"
    actor_id: "user-42"
    http.response.status_code: 404
    duration_ms: 0.751872
    outcome: "error"
    error.type: "NotFoundException"
    error.message: "Job not-found not found"
```

`outcome: "error"`, `error.type`, and `error.message` are added by `CanonicalLogExceptionFilter` — the line still emits even though the controller threw. `actor_id` is preserved because it was set before the exception. `job.id` is absent because the service threw before reaching the `addFields` call: **the gap is the signal** — it tells you the lookup failed at find-time, not at any later step.

### 4. Validation error — `PATCH /jobs/:id/status` with empty body

```bash
curl -X PATCH http://localhost:3000/jobs/job-123/status \
  -H 'Content-Type: application/json' \
  -d '{"status":""}'
```

Response:
```json
{"message":"status is required","error":"Bad Request","statusCode":400}
```

Canonical line:
```
[01:18:03.456] INFO: canonical
    http.route: "/jobs/:id/status"
    actor_id: "user-42"
    http.response.status_code: 400
    duration_ms: 0.300575
    outcome: "error"
    error.type: "BadRequestException"
    error.message: "status is required"
```

Same failure-correctness invariant: the line emits, with the validation message captured. No `job.id` / `job.status_from` because the service threw on the input check before fetching anything.

## What to take away

- **One line per request, success or failure.** Four very different code paths, four identically-shaped log records — queryable, faceted, alertable.
- **Sparseness is signal.** Compare the four lines: every absent field tells you something about where the request died.
- **The auth layer contributes once.** `actor_id` is set in one middleware and appears on every line, including errors. Nothing in `JobsService` knows about auth.
- **Field names are stable.** They follow OTEL semantic conventions, so a dashboard built today still works if you migrate to APM spans tomorrow.
