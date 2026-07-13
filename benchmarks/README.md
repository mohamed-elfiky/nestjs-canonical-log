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

Three scenarios run against one handler:

**Scenarios:**
1. `bare-nest`: no logging.
2. `nest+pino`: nestjs-pino mounted, per-request line to a discarding stream.
3. `nest+pino+canonical`: same as (2) plus `CanonicalLogModule`.

**Handlers:**
- `/work`: awaits ~50 ms of simulated I/O (`setTimeout`). Approximates a real handler doing a DB read or a warm downstream call.

The delta line at the bottom of each suite reports the difference between `nest+pino` and `nest+pino+canonical`.

## Interpretation

Reference numbers, dev machine, 3s runs, 50 connections, `BENCH_WORK_MS=50`:

```
=== (/work) ===
scenario                req/s       p50 (ms)    p99 (ms)
------------------------------------------------------------
bare-nest                950.00       52.00       60.00
nest+pino                954.67       51.00       69.00
nest+pino+canonical      953.34       51.00       62.00

adding canonical to pino-only: -0.1% req/s, +-7.00 ms p99
```

