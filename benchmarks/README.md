# Benchmarks

Micro-benchmarks for the CPU/allocation cost of `nestjs-canonical-log`.

## Running

```bash
pnpm bench
# knobs:
BENCH_DURATION=10 BENCH_CONNECTIONS=100 BENCH_WORK_MS=100 pnpm bench

# with a flamegraph (requires 0x, output goes to benchmarks/.flamegraph/):
pnpm bench:profile
```

## What it measures

Three scenarios run against two handlers each:

**Scenarios:**
1. `bare-nest`: no logging.
2. `nest+pino`: nestjs-pino mounted, per-request line to a discarding stream.
3. `nest+pino+canonical`: same as (2) plus `CanonicalLogModule`.

**Handlers:**
- `/ping`: synchronous no-op (`return { ok: true }`). Isolates library CPU cost. Useful for regression detection, misleading for judging production impact.
- `/work`: awaits ~50 ms of simulated I/O (`setTimeout`). Approximates a real handler doing a DB read or a warm downstream call. **This is the number that matters for production.**

The delta line at the bottom of each suite reports the difference between `nest+pino` and `nest+pino+canonical`.

## Interpretation

Reference numbers, dev machine, 3s runs, 50 connections, `BENCH_WORK_MS=50`:

```
=== no-op handler (/ping) ===
scenario                req/s       p50 (ms)    p99 (ms)
------------------------------------------------------------
bare-nest              16094.67        2.00        5.00
nest+pino               8618.00        5.00        9.00
nest+pino+canonical     5867.34        7.00       16.00

adding canonical to pino-only: -31.9% req/s, +7.00 ms p99

=== realistic handler (/work) ===
scenario                req/s       p50 (ms)    p99 (ms)
------------------------------------------------------------
bare-nest                950.00       52.00       60.00
nest+pino                954.67       51.00       69.00
nest+pino+canonical      953.34       51.00       62.00

adding canonical to pino-only: -0.1% req/s, +-7.00 ms p99
```

**Read the `/work` numbers, not the `/ping` numbers.** Real handlers do meaningful work (DB reads, HTTP calls, business logic) that dwarfs the ~1-3 ms of canonical overhead. When the handler takes 50 ms of real time, that overhead is statistically invisible: the canonical run is within noise of the pino-only run.

The `/ping` micro-benchmark exists because it's a sensitive regression detector. A -31% delta against a no-op handler catches per-request bloat that a realistic handler would hide. But a scary-looking micro-benchmark headline does not describe what production feels.

## What it does not measure

- stdout / real log shipping. Discarding the stream isolates library CPU cost from stdio throughput.
- Distributed tracing overhead (dd-trace, OpenTelemetry, log injection). Those stack on top of what we measure here.
- Concurrent workloads under contention. 50 connections is not thousands of connections holding DB transactions.
- Long-running GC. 3-5s runs don't exercise V8 optimization tiers or hours-long GC pressure.

## Profiling

`pnpm bench:profile` runs the canonical scenario against `/ping` for 15 seconds (override with `PROFILE_DURATION`) and produces `benchmarks/.flamegraph/flamegraph.html`. Open it in a browser and zoom into the hot stacks. Function-level self-time can be extracted from the sibling `.v8.log.json`.

The last profile showed our own library code was around 9% of total CPU on the `/ping` micro-benchmark. About two-thirds of the "adding canonical" delta came from `nestjs-cls` middleware setting up an AsyncLocalStorage context per request, which is structural to any per-request-context library, not specific to this one. The rest is the RxJS interceptor machinery and the finalize callback writing the record and calling the logger. On `/work` all of that is below the noise floor.

## When to update these numbers

- After any change that touches the request path (`CanonicalLogService`, the interceptor, the filter, the middleware).
- Before publishing a minor/major release, as a regression check on `/ping`.
- Not per-PR. Manual check, not a CI gate. Variance between runs on the same machine is easily 5-10%.
