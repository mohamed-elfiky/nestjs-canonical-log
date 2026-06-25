# nestjs-canonical-log

One structured log line per HTTP request following the [Stripe canonical log line pattern](https://stripe.com/blog/canonical-log-lines).

> **See it running:** [`example/`](./example/README.md), a minimal NestJS app with auth + a jobs domain, walking through what the canonical line looks like for success, state transitions, controller errors, and validation errors.

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

This feels thorough. It is not observability. It is breadcrumbs.

The problems:

- **You can't query it.** "How many jobs were updated by tenant X in the last hour, and what was the p99 latency?" requires parsing free-text across millions of lines.
- **It breaks on failure.** The exception bubbles before the "returning 200" line emits. You get half a trail and have to infer the rest.
- **Volume without density.** Six lines, one request, none of them individually answerable. You need all six to reconstruct what happened — and they're interleaved with every other concurrent request.
- **It's random.** Every engineer decides independently what to log, when, and with what fields. There is no contract.

### Calculated observability

Observability, properly defined, is the ability to ask arbitrary questions about your system's behaviour from the outside — without shipping new code to answer them. The key word is **arbitrary**: you don't know in advance what questions an incident will require.

The canonical log pattern is the practical implementation of this for request-scoped systems. The insight is simple:

> **One request = one event. The event is the unit of observability.**

Instead of emitting breadcrumbs as the request progresses, you accumulate facts into a single structured record and emit it exactly once at the end — success or failure. That record is your event. It is flat, dense, and queryable.

Now "how many jobs were updated by tenant X in the last hour, p99 latency?" is a single Datadog query:

```
service.name:my-api http.route:/v1/jobs/:id/status outcome:ok tenant_id:acct_8f2c
```

Group by `tenant_id`, percentile on `duration_ms`. Done.

### The failure-correctness invariant

This is the single most important property of the pattern and the hardest to get right.

**The line must emit on failure, with full error detail.** Not "usually". Not "unless it's a 500". Always.

This is why Stripe wraps the entire request in a Ruby `ensure` block — the canonical equivalent of `finally`. A line that only emits on success is useless for the one case where you need it most: the 3am incident where the request died mid-flight and you need to know exactly where and why.

This implementation achieves failure-correctness through a split: the interceptor drains on success, the exception filter drains on error, and `drain()` is idempotent so both can call it without coordination. The flag that enforces exactly-once lives in the per-request CLS bag, not in the callers.

### Sparseness is signal

Domain fields are set incrementally as work happens:

```typescript
// Set before the DB write
canonicalLog.addFields({ 'job.id': id, 'job.status_from': job.status })

// Set only after the DB write succeeds
canonicalLog.addFields({ 'job.status_to': newStatus })
```

If the write throws, `job.status_to` is absent from the canonical line. That absence is not noise — it's a precise marker of where the request died. You don't need to correlate breadcrumbs. The gap tells you.

### Fields are a contract, not a convenience

Random logs rot. Engineers change strings, rename keys, drop fields — and nothing breaks at compile time. Canonical fields are different: they are the queryable API of your observability system. Dashboards, alerts, and SLO monitors are built on them. Breaking a field name breaks an alert.

This is why:

- **Framework fields** (`http.route`, `http.response.status_code`, etc.) are set by the mechanism, never by application code. You cannot accidentally break them.
- **Kernel fields** (`tenant_id`, `actor_id`, `actor_type`) are cross-cutting and owned by the auth layer. One place, one team, one contract.
- **Domain fields** are namespaced (`job.id`, `billing.invoice_id`) and typed locally at the call site. TypeScript enforces the shape within a module; the namespace enforces non-collision across modules.
- **Field names follow OTEL semantic conventions.** Not because we use OpenTelemetry, but because OTEL names are stable, widely known, and natively parsed by Datadog. If you migrate from logs to spans, the field names port without renaming.

### Why logs, not spans

Distributed tracing spans are the richer primitive: they carry timing, parent-child relationships across services, and arbitrary attributes. The canonical log line is a deliberate downgrade of that richness in exchange for cost.

For example Datadog APM spans are priced per ingested volume. At scale, this is significant. Log management is priced differently. And a single structured log line per request at log-management pricing gives you the same analytics capability for incident triage and SLO tracking.

The tradeoff you accept: no automatic cross-service trace stitching from canonical logs alone. If you need distributed traces (and you might), run `dd-trace` alongside. The canonical line and the APM trace are complementary. The trace gives you the distributed call graph; the canonical line gives you the per-request summary row that answers "what happened and to whom" without opening a trace viewer.

Field names follow OTEL so that if you later decide the traces are worth the cost, migrating is a configuration change, not a field rename.

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

On failure the line still emits — with error detail instead of success fields:

```json
{
  "service.name": "my-api",
  "http.request.method": "PATCH",
  "http.route": "/v1/jobs/:id/status",
  "http.response.status_code": 500,
  "duration_ms": 5012,
  "outcome": "error",
  "error.type": "QueryTimeoutError",
  "error.message": "statement timeout exceeded",
  "tenant_id": "acct_8f2c",
  "actor_id": "usr_4471",
  "job.id": "job_99a1",
  "job.status_from": "scheduled"
}
```

`job.status_to` is absent — the write never completed. Sparseness is signal.

---

## How it works — the four pieces

```
Request
  │
  ▼
┌─────────────────────────────┐
│  CanonicalLogMiddleware      │  initialize() — create bag in CLS, start clock,
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
│ drain() ✓  │  │ drain() ✓                 │
└────────────┘  │ super.catch() → response  │
                └──────────────────────────┘
```

**Key invariant:** `drain()` is idempotent — whichever path fires first, the line emits once. The flag lives in the CLS bag, not in the callers, so there is no coordination needed between interceptor and filter.

**Why finalize() skips drain() on error:** In NestJS, RxJS `finalize()` fires *before* the exception filter (finalize is observable teardown; the filter is called after the subscription settles). If finalize drained unconditionally, the line would emit without error fields. The interceptor tracks `hasError` via `tap({ error })` and skips drain on the error path, leaving it to the filter.

---

## Installation

```bash
npm install nestjs-canonical-log
# peer deps
npm install nestjs-cls nestjs-pino rxjs reflect-metadata
```

---

## Setup

> Prefer to read code? The full setup is in [`example/`](./example/README.md) — a runnable NestJS app you can `pnpm start` and probe with `curl`.

### 1. Prerequisites in your AppModule

`ClsModule` must be mounted **before** `CanonicalLogModule` in the imports array:

```typescript
import { Module } from '@nestjs/common'
import { ClsModule } from 'nestjs-cls'
import { LoggerModule } from 'nestjs-pino'
import { CanonicalLogModule } from 'nestjs-canonical-log'

@Module({
  imports: [
    // 1. CLS — must come first so the scope opens before our middleware runs
    ClsModule.forRoot({ global: true, middleware: { mount: true } }),

    // 2. nestjs-pino — canonical line emits through PinoLogger
    LoggerModule.forRoot({ pinoHttp: { level: 'info' } }),

    // 3. Canonical log — one line, globally wired
    CanonicalLogModule.forRoot({
      service: 'my-api',
      env: process.env.NODE_ENV,
    }),
  ],
})
export class AppModule {}
```

### 2. Wire identity (kernel fields)

Inject `CanonicalLogService` wherever you resolve the authenticated user and call `addFields`:

```typescript
import { Injectable } from '@nestjs/common'
import { CanonicalLogService } from 'nestjs-canonical-log'

@Injectable()
export class AuthGuard {
  constructor(private readonly canonicalLog: CanonicalLogService) {}

  canActivate(context: ExecutionContext): boolean {
    const user = resolveUser(context)
    this.canonicalLog.addFields({
      tenant_id: user.tenantId,
      actor_id: user.id,
      actor_type: 'human',
    })
    return true
  }
}
```

### 3. Contribute domain fields from any service

Define a local type with namespaced keys, pass it as the generic:

```typescript
type JobFields = {
  'job.id'?: string
  'job.status_from'?: string
  'job.status_to'?: string
}

@Injectable()
export class JobsService {
  constructor(private readonly canonicalLog: CanonicalLogService) {}

  async updateStatus(id: string, newStatus: string) {
    const job = await this.repo.find(id)

    this.canonicalLog.addFields<JobFields>({
      'job.id': id,
      'job.status_from': job.status,
    })

    await this.repo.update(id, newStatus)

    // Only set status_to after the write succeeds.
    // If it throws, this line never runs — gap in the log = signal.
    this.canonicalLog.addFields<JobFields>({ 'job.status_to': newStatus })
  }
}
```

---

## Fastify

```typescript
import { FastifyAdapter } from 'nestjs-canonical-log'

CanonicalLogModule.forRoot({
  service: 'my-api',
  adapter: new FastifyAdapter(),
})
```

Custom platform: implement `CanonicalHttpAdapter` (two methods: `getRoutePath` and `getRawPath`).

---

## Correlation IDs (Datadog)

Correlation Ids should be injected automatically by your instrumentaion library. Zero code needed in this module they should appear in every log line including the canonical one.

---

## Field reference

Names follow [OTEL semantic conventions](https://opentelemetry.io/docs/specs/semconv/http/http-spans/) so they port directly to spans if you later adopt distributed tracing.

| Field                       | OTEL ref      | Set by                   | Notes                                          |
| --------------------------- | ------------- | ------------------------ | ---------------------------------------------- |
| `service.name`              | resource attr | module init              | from `forRoot({ service })`                    |
| `deployment.environment`    | resource attr | module init              | from `forRoot({ env })`                        |
| `timestamp`                 | —             | middleware               | ISO-8601, request arrival                      |
| `http.request.method`       | http spans    | middleware               | uppercase verb                                 |
| `http.route`                | http spans    | interceptor              | parameterized template, e.g. `/v1/jobs/:id`    |
| `http.response.status_code` | http spans    | interceptor / filter     |                                                |
| `duration_ms`               | —             | interceptor / filter     | wall-clock ms; OTEL uses ns but ms is readable |
| `outcome`                   | —             | interceptor / filter     | `"ok"` or `"error"` — cheap Datadog facet      |
| `error.type`                | error attrs   | filter                   | exception class name                           |
| `error.message`             | error attrs   | filter                   | exception message                              |
| `tenant_id`                 | —             | caller (auth layer)      | kernel field, optional                         |
| `actor_id`                  | —             | caller (auth layer)      | kernel field, optional                         |
| `actor_type`                | —             | caller (auth layer)      | kernel field, optional                         |
| `*.*`                       | —             | caller (domain services) | namespaced, sparse, typed locally              |

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
