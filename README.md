# nestjs-canonical-log
<p align="center">
  <img
    width="840"
    alt="A canoe-nical log illustration"
    src="https://github.com/user-attachments/assets/3db5de13-bee8-4cff-9122-2fa6631b16f9"
  />
</p>
One structured log line per HTTP request following the [Stripe canonical log line pattern](https://stripe.com/blog/canonical-log-lines).

> **See it running:** [`example/`](./example/README.md), a runnable Nest app covering success, state transitions, and errors.

---

## Philosophy

### The problem with breadcrumb logging

Most applications log like this:

```
INFO  Received PATCH /v1/jobs/abc123
INFO  Fetching job abc123 from database
INFO  Job found, current status: scheduled
INFO  Updating status to in_progress
INFO  Status updated successfully
INFO  Returning 200
```

The problems:

- **You can't query it.** "How many jobs did tenant X update in the last hour at what p99?" needs free-text parsing across millions of lines.
- **It breaks on failure.** The exception bubbles before "returning 200". Half a trail, infer the rest.
- **Volume without density.** Six lines, one request, none individually answerable. Interleaved with every other concurrent request.
- **It's random.** No contract. Every engineer picks their own fields.

### The idea

Observability is asking arbitrary questions about system behavior without shipping new code. Canonical logs implement that for request-scoped systems:

> **One request = one event. Emit it once at the end.**

Now the tenant-X question is one query:

```
service.name:my-api http.route:/v1/jobs/:id/status outcome:ok tenant_id:acct_8f2c
```

Group by `tenant_id`, percentile on `duration_ms`. Done.

### Errors must still emit a line

The hardest part to get right. The line must emit on failure, with full error detail. Always.

This library handles that with a split: the interceptor flushes on success, the exception filter flushes on error. `flush()` is idempotent, so if both fire the second is a safe no-op.

### The `stage` field tells you where it broke

Every canonical line carries a `stage` field. Update it as work progresses. The value at emit time tells anyone reading the line where the request stopped, no handler knowledge required.

```typescript
type JobStage = 'fetching_job' | 'writing_status' | 'notifying' | 'done'

canonicalLog.stage<JobStage>('fetching_job')
const job = await db.getJob(id)

canonicalLog.stage<JobStage>('writing_status')
await db.updateStatus(job.id, newStatus)

canonicalLog.stage<JobStage>('done')
```

If the DB write throws, the line has `stage: "writing_status"`. Group by `stage` where `outcome:error` shows which stages fail most.

Pass a local union type as the generic to enforce a stage enum at compile time (prevents typos and cardinality drift). If you never set a stage, the terminal value is `request_started`.

### Fields are part of your API

Random logs rot. Canonical fields are the queryable API your dashboards and alerts depend on. Break a field name, break an alert.

- **Framework fields** (`http.route`, `http.response.status_code`, etc.): set by the library, never by application code.
- **Shared fields** (`tenant_id`, `actor_id`, `actor_type`): cross-cutting, owned by the auth layer.
- **Domain fields** (`job.id`, `billing.invoice_id`): namespaced, typed locally at the call site.
- **Names follow OTEL** where practical, so migrating to spans is mostly a config change. Deviations: `duration_ms` (OTEL uses ns; ms is readable) and `outcome` (custom).

### Why logs, not spans

Spans are the richer primitive. Canonical logs are the simpler one.

**"Why not one wide span per request instead?"** Sampling. APM vendors drop most successful traces at ingest, head-based or tail-based, so "what happened to *this specific* request from tenant X at 3:42 PM?" often can't be answered because the span wasn't kept. Logs are typically retained without sampling, so a canonical line gives 100% coverage of every request. That's the real differentiator.

**What you lose:** distributed call graph, waterfall of internal calls, auto-instrumentation of downstream clients. **What you keep:** group-by-anything queries, percentiles, error-rate SLOs, per-request triage. If you need the graph, run OpenTelemetry or `dd-trace` alongside. They're complementary.

### Why not just pino-http?

pino-http already emits one line per request, and nestjs-pino's `assign()` can even add fields to it. Two things it can't do:

**A contract.** `assign()` takes `Record<string, any>`: no typed fields, no stage enum, nothing stopping `tenantId` / `tenant_id` drift across modules. `addFields<T>()` and `stage<T>()` are checked at compile time.

**Requests that never finish.** pino-http logs on response completion. A handler stuck on a dead await never completes — and waiting forever is the shipped default in more places than you'd think (axios `timeout: 0`, pg-pool `connectionTimeoutMillis: 0`, Postgres `lock_timeout: 0`). So:

| Scenario | pino-http | this library |
| --- | --- | --- |
| Client keeps waiting | nothing, indefinitely | `outcome: "timeout"` + `stage` at the TTL |
| Client / LB gives up | `request aborted`, `statusCode: null`, no context | `outcome: "timeout"` + `stage` at the TTL |

Measured against the [example app](./example/README.md): hit `/jobs/hang` and watch. The canonical line is the only one that says *where* the request was stuck, and it fires on a clock you control instead of the client's patience.

### PII

Canonical logs concentrate risk. One line packs tenant, actor, and error message. This library does no redaction; configure redaction at your logger layer (e.g. pino's `redact` option, or your custom `ICanonicalLogger` implementation) and don't put raw PII in `addFields()`.

---

## What it produces

Every HTTP request emits exactly one JSON line with `"msg":"canonical"`:

```json
{
  "service.name": "my-api",
  "deployment.environment": "prod",
  "timestamp": "2026-06-22T09:14:03.221Z",
  "http.request.method": "PATCH",
  "http.route": "/v1/jobs/:id/status",
  "http.response.status_code": 200,
  "duration_ms": 143,
  "outcome": "ok",
  "stage": "done",
  "tenant_id": "acct_8f2c",
  "actor_id": "usr_4471",
  "actor_type": "human",
  "job.id": "job_99a1",
  "job.status_from": "scheduled",
  "job.status_to": "in_progress",
  "db.queries": 4,
  "db.ms": 88
}
```

On failure the line still emits, with error detail instead of success fields:

```json
{
  "service.name": "my-api",
  "http.request.method": "PATCH",
  "http.route": "/v1/jobs/:id/status",
  "http.response.status_code": 500,
  "duration_ms": 5012,
  "outcome": "error",
  "stage": "writing_status",
  "error.type": "QueryTimeoutError",
  "error.message": "statement timeout exceeded",
  "tenant_id": "acct_8f2c",
  "actor_id": "usr_4471",
  "job.id": "job_99a1",
  "job.status_from": "scheduled"
}
```

`job.status_to` is absent. The write never completed. That's the whole point.

---

## How it works: the four pieces

```
Request
  │
  ▼
┌─────────────────────────────┐
│  CanonicalLogMiddleware      │  initialize() — create record in CLS, start clock,
│                              │  seed service.name / http.request.method / http.route (raw)
└──────────────┬──────────────┘
               │
               ▼
         [Guards / Pipes]
               │
               ▼
┌─────────────────────────────┐
│  CanonicalLogInterceptor     │  overwrite http.route with the parameterized template
│  (before handler)            │  now that NestJS has resolved the handler
└──────────────┬──────────────┘
               │
               ▼
         [Controller]
               │
        ┌──────┴──────┐
        │ success      │ error (throws)
        ▼              ▼
┌────────────┐  ┌──────────────────────────┐
│ Interceptor│  │ CanonicalLogExceptionFilter│
│ finalize() │  │ catch()                   │
│            │  │                           │
│ status ✓   │  │ error.type ✓              │
│ duration ✓ │  │ error.message ✓           │
│ outcome:ok │  │ outcome:error             │
│ flush() ✓  │  │ flush() ✓                 │
└────────────┘  │ super.catch() → response  │
                └──────────────────────────┘
```

**Idempotent flush:** whichever path fires first emits the line. The flag lives in the CLS record so interceptor and filter don't have to coordinate.

**Why the interceptor skips flush on error:** RxJS `finalize()` fires before the exception filter, so flushing there would emit without error fields. The interceptor sets `hasError` via `tap({ error })` and lets the filter flush after enriching.

---

## Installation

```bash
npm install nestjs-canonical-log
# required peer deps
npm install nestjs-cls rxjs reflect-metadata
```

Then pick a logger:

```bash
# option A: use the default (nestjs-pino)
npm install nestjs-pino
```

Or bring your own by implementing `ICanonicalLogger` (two lines) and passing it via `forRoot({ logger })`. See [Setup](#setup) below.

---

## Setup

> Prefer code? Full setup in [`example/`](./example/README.md).

### 1. AppModule wiring

`ClsModule` must come **before** `CanonicalLogModule`. Call `forRoot()` once, in the root module — it registers globally.

```typescript
@Module({
  imports: [
    ClsModule.forRoot({ global: true, middleware: { mount: true } }),
    LoggerModule.forRoot({ pinoHttp: { level: 'info' } }), // or skip and pass { logger } below
    CanonicalLogModule.forRoot({
      'service.name': 'my-api',
      'deployment.environment': process.env.NODE_ENV,
    }),
  ],
})
export class AppModule {}
```

### 2. Wire identity (shared fields)

Inject `CanonicalLogService` in your auth guard and call `addFields`:

```typescript
@Injectable()
export class AuthGuard {
  constructor(private readonly canonicalLog: CanonicalLogService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const user = resolveUser(ctx)
    this.canonicalLog.addFields({
      tenant_id: user.tenantId,
      actor_id: user.id,
      actor_type: 'human',
    })
    return true
  }
}
```

### 3. Contribute domain fields

Pass a local type as the generic for call-site type safety:

```typescript
type JobFields = { 'job.id'?: string; 'job.status_from'?: string; 'job.status_to'?: string }

async updateStatus(id: string, newStatus: string) {
  const job = await this.repo.find(id)
  this.canonicalLog.addFields<JobFields>({ 'job.id': id, 'job.status_from': job.status })
  await this.repo.update(id, newStatus)
  this.canonicalLog.addFields<JobFields>({ 'job.status_to': newStatus })
}
```

---

## Fastify

```typescript
import { FastifyAdapter } from 'nestjs-canonical-log/fastify'

CanonicalLogModule.forRoot({
  'service.name': 'my-api',
  adapter: new FastifyAdapter(),
})
```

Custom platform: implement `CanonicalHttpAdapter` (`getRoutePath` + `getRawPath`).

---

## Correlation IDs

Handled by your instrumentation library (dd-trace, OpenTelemetry, etc). They appear on every log line, canonical included. Zero code here.

---

## Field reference

Names follow [OTEL semantic conventions](https://opentelemetry.io/docs/specs/semconv/http/http-spans/) so they port directly to spans if you later adopt distributed tracing.

| Field                       | OTEL ref      | Set by                   | Notes                                                                    |
| --------------------------- | ------------- | ------------------------ | ------------------------------------------------------------------------ |
| `service.name`              | resource attr | module init              | from `forRoot({ service })`                                              |
| `deployment.environment`    | resource attr | module init              | from `forRoot({ env })`                                                  |
| `timestamp`                 | —             | middleware               | ISO-8601, request arrival                                                |
| `http.request.method`       | http spans    | middleware               | uppercase verb                                                           |
| `http.route`                | http spans    | interceptor              | parameterized template, e.g. `/v1/jobs/:id`                              |
| `http.response.status_code` | http spans    | interceptor / filter     |                                                                          |
| `code.namespace`            | code attrs    | interceptor              | controller class name, e.g. `JobsController`                            |
| `code.function`             | code attrs    | interceptor              | handler method name, e.g. `updateStatus`                                |
| `duration_ms`               | —             | interceptor / filter     | wall-clock ms; OTEL uses ns but ms is readable                           |
| `outcome`                   | —             | interceptor / filter     | `"ok"`, `"error"`, `"timeout"` (TTL expired), `"shutdown"` (app closed)  |
| `stage`                     | —             | service (`stage()`)      | where the request was; defaults to `"request_started"`                   |
| `error.type`                | error attrs   | filter                   | exception class name (queryable dimension)                               |
| `error.message`             | error attrs   | filter                   | exception message (contextual, no stack; use an error tracker for that)  |
| `tenant_id`                 | —             | caller (auth layer)      | shared field, optional                                                   |
| `actor_id`                  | —             | caller (auth layer)      | shared field, optional                                                   |
| `actor_type`                | —             | caller (auth layer)      | shared field, optional                                                   |
| `*.*`                       | —             | caller (domain services) | namespaced, sparse, typed locally                                        |

---

## Limitations

- **HTTP requests only.** Background jobs (BullMQ, cron, queue workers) aren't wired. You get canonical lines for HTTP hops, not for the background work in between.
- **SSE/streaming disconnects read as success.** When a client disconnects from a streaming endpoint mid-stream, the line emits with `outcome: "ok"`.

---

## Peer dependencies

| Package            | Version          |
| ------------------ | ---------------- |
| `@nestjs/common`   | `^10 \|\| ^11`   |
| `@nestjs/core`     | `^10 \|\| ^11`   |
| `nestjs-cls`       | `^4`             |
| `nestjs-pino`      | `^3 \|\| ^4`     |
| `rxjs`             | `^7`             |
| `reflect-metadata` | `^0.1 \|\| ^0.2` |
