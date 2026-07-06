# Benchmarks

Micro-benchmarks for the CPU/allocation cost of `nestjs-canonical-log`.

## Running

```bash
pnpm bench
# knobs:
BENCH_DURATION=10 BENCH_CONNECTIONS=100 pnpm bench

# with a flamegraph (requires 0x, output goes to benchmarks/.flamegraph/):
pnpm bench:profile
```

## What it measures

Three scenarios against the same `/ping` handler returning `{ ok: true }`:

1. `bare-nest`: no logging at all. Absolute floor for a NestJS app.
2. `nest+pino`: typical production baseline: `nestjs-pino` mounted with
   `pinoHttp` emitting one line per request. Log output goes to a discarding
   stream so we're measuring pino cost, not stdout I/O.
3. `nest+pino+canonical`: same as (2) plus `CanonicalLogModule`.

The line at the bottom of the output reports the delta between (2) and (3).
That's the number consumers actually care about.

## What it does not measure

- A realistic handler. Every request is a synchronous return of a small
  object. Real handlers do DB reads, HTTP calls, business logic, often
  10–100 ms per request. A few ms of canonical overhead is a small
  fraction of that in production, but a large fraction of a no-op.
- stdout / real log shipping. Discarding the stream isolates library CPU
  cost from stdio throughput. In prod your pino transport (JSON to file,
  remote sink) adds cost this benchmark hides.
- Distributed tracing overhead. `dd-trace`, OpenTelemetry, correlation-ID
  injection, log-injection plugins all add per-request cost that stacks
  on top of what we measure here.
- Concurrent workloads under contention. 50 connections against a no-op
  is not thousands of connections holding DB transactions open.
- Long-running GC. Runs are 5s each; V8 optimization tiers and GC
  pressure over hours aren't exercised.

## Interpreting the delta

Reference numbers from a dev machine (Node 24, 5s runs, 50 connections):

```
scenario                req/s       p50 (ms)    p99 (ms)
------------------------------------------------------------
bare-nest               17944.80        2.00        4.00
nest+pino                9520.80        4.00        7.00
nest+pino+canonical      6521.20        7.00       14.00

adding canonical to pino-only: -31.5% req/s, +7.00 ms p99
```

The `-31%` looks alarming. It isn't as bad as it reads. Two things to
understand:

**1. Where the cost actually lives.** From a flamegraph of the canonical
scenario, our own library code accounts for about 9% of total time. The
rest of the delta comes from:

| Component                          | Share of total | Whose code |
| ---------------------------------- | -------------- | ---------- |
| `nestjs-cls` middleware            | ~17%           | nestjs-cls (AsyncLocalStorage per request) |
| RxJS operator machinery            | ~7–10%         | Nest interceptor/filter internals |
| Our interceptor finalize + service | ~9%            | this library |

Adding CanonicalLogModule brings in `ClsModule.forRoot({ middleware: { mount: true } })`,
and the CLS middleware wrap accounts for most of the delta. That's structural
to any per-request-context library, not something specific to how we're built.

**2. Absolute cost is the useful number, not relative.** On the reference
run, adding canonical costs about 3 ms of p50 latency on a request that
was 4 ms without it. On a real handler doing 50 ms of DB and business
logic, the same 3 ms is a 6% slowdown, noticeable but not catastrophic.
Run this on your target hardware if the numbers matter to your workload.

## Profiling

`pnpm bench:profile` boots just the canonical scenario for 15s (default,
override with `PROFILE_DURATION`) and produces an interactive flamegraph
HTML at `benchmarks/.flamegraph/flamegraph.html`. Open it in a browser and
zoom into the hot stacks. Function-level self-time can also be extracted
from the accompanying `.v8.log.json`.

## When to update these numbers

- After any change that touches the request path
  (`CanonicalLogService`, the interceptor, the filter, the middleware).
- Before publishing a minor/major release, as a regression check.
- Not per-PR. This is a manual check, not a CI gate, variance between
  runs on the same machine is easily 5–10%.
