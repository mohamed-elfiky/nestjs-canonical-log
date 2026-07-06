/**
 * Overhead benchmark. Same three scenarios (bare-nest / nest+pino /
 * nest+pino+canonical) run against two handlers:
 *
 *   /ping     — synchronous no-op. Isolates library CPU cost. Useful for
 *               regression detection, misleading for judging production impact.
 *   /work     — awaits ~50 ms of simulated I/O. Approximates a real handler
 *               (DB read, downstream HTTP call, etc). This is the number
 *               that reflects what consumers actually feel.
 *
 * Log output goes to a discarding stream so we measure CPU/allocation cost,
 * not stdio throughput.
 */
import 'reflect-metadata'
import { Writable } from 'node:stream'
import autocannon from 'autocannon'
import { Controller, Get, Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { ClsModule } from 'nestjs-cls'
import { LoggerModule } from 'nestjs-pino'
import { CanonicalLogModule } from '../src/index'

const DURATION_SEC = Number(process.env.BENCH_DURATION ?? 5)
const CONNECTIONS = Number(process.env.BENCH_CONNECTIONS ?? 50)
const WORK_MS = Number(process.env.BENCH_WORK_MS ?? 50)
const PORT_BASE = 4001
const PORT_PINO = 4002
const PORT_CANONICAL = 4003

@Controller()
class HelloController {
  @Get('/ping')
  ping() {
    return { ok: true }
  }

  @Get('/work')
  async work() {
    // Approximates real request work: async I/O that yields the event loop.
    // 50ms is in the ballpark of a fast DB read or a warm downstream call.
    await new Promise(r => setTimeout(r, WORK_MS))
    return { ok: true }
  }
}

// 1. Bare Nest
@Module({ controllers: [HelloController] })
class BareModule {}

// Common pino config for scenarios 2 and 3 — logs go to a discarding stream
// so we don't measure stdout serialization.
const devNull = new Writable({ write: (_c, _e, cb) => cb() })
const pinoConfig = {
  pinoHttp: {
    level: 'info' as const,
    autoLogging: true, // emit one request line so this is a realistic pino setup
    quietReqLogger: true,
    stream: devNull,
  },
}

// 2. Nest + pino-http (no canonical)
@Module({
  imports: [LoggerModule.forRoot(pinoConfig)],
  controllers: [HelloController],
})
class PinoOnlyModule {}

// 3. Nest + pino-http + canonical
@Module({
  imports: [
    ClsModule.forRoot({ global: true, middleware: { mount: true } }),
    LoggerModule.forRoot({
      pinoHttp: {
        ...pinoConfig.pinoHttp,
        autoLogging: false, // canonical replaces per-request logging
      },
    }),
    CanonicalLogModule.forRoot({ 'service.name': 'bench' }),
  ],
  controllers: [HelloController],
})
class CanonicalModule {}

async function runOne(port: number, path: string): Promise<autocannon.Result> {
  return new Promise((resolve, reject) => {
    autocannon(
      {
        url: `http://127.0.0.1:${port}${path}`,
        connections: CONNECTIONS,
        duration: DURATION_SEC,
      },
      (err, result) => (err ? reject(err) : resolve(result)),
    )
  })
}

async function runScenario(name: string, moduleClass: unknown, port: number, path: string) {
  const app = await NestFactory.create(moduleClass as never, { logger: false })
  await app.listen(port)
  const result = await runOne(port, path)
  await app.close()
  return { name, result }
}

function pad(s: string, n: number) {
  return s.padEnd(n)
}
function fmt(n: number, w = 8) {
  return n.toFixed(2).padStart(w)
}

async function runSuite(label: string, path: string) {
  process.stderr.write(`\n=== ${label} (${path}) ===\n\n`)

  const scenarios = [
    await runScenario('bare-nest', BareModule, PORT_BASE, path),
    await runScenario('nest+pino', PinoOnlyModule, PORT_PINO, path),
    await runScenario('nest+pino+canonical', CanonicalModule, PORT_CANONICAL, path),
  ]

  const header = pad('scenario', 24) + pad('req/s', 12) + pad('p50 (ms)', 12) + pad('p99 (ms)', 12)
  process.stderr.write(header + '\n')
  process.stderr.write('-'.repeat(header.length) + '\n')

  for (const { name, result } of scenarios) {
    process.stderr.write(
      pad(name, 24) +
        pad(fmt(result.requests.average), 12) +
        pad(fmt(result.latency.p50), 12) +
        pad(fmt(result.latency.p99), 12) +
        '\n',
    )
  }

  const pinoOnly = scenarios[1]!.result
  const canonical = scenarios[2]!.result
  const rpsDelta =
    ((canonical.requests.average - pinoOnly.requests.average) / pinoOnly.requests.average) * 100
  const p99Delta = canonical.latency.p99 - pinoOnly.latency.p99

  process.stderr.write(
    `\nadding canonical to pino-only: ${rpsDelta.toFixed(1)}% req/s, +${p99Delta.toFixed(2)} ms p99\n`,
  )
}

async function main() {
  process.stderr.write(
    `\nbench: ${CONNECTIONS} connections, ${DURATION_SEC}s per run, ${WORK_MS}ms simulated work in /work\n`,
  )

  await runSuite('no-op handler', '/ping')
  await runSuite('realistic handler', '/work')

  process.stderr.write(
    '\nnote: /ping is a micro-benchmark. Judge production impact by /work.\n\n',
  )
}

main().catch(err => {
  process.stderr.write(`bench failed: ${String(err)}\n`)
  process.exit(1)
})
