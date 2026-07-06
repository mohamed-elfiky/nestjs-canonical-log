/**
 * Overhead benchmark. Three scenarios, same handler:
 *
 *   1. Bare Nest             — no logging at all. Absolute floor.
 *   2. Nest + pino-http      — typical production baseline (per-request line
 *                              from pino-http, no canonical).
 *   3. Nest + pino-http + canonical — same setup as (2) + our library on top.
 *
 * Everything logs to /dev/null equivalent (a discarding stream) so we measure
 * CPU/allocation cost, not I/O to stdout.
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
const PORT_BASE = 4001
const PORT_PINO = 4002
const PORT_CANONICAL = 4003

@Controller()
class HelloController {
  @Get('/ping')
  ping() {
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

async function runOne(port: number): Promise<autocannon.Result> {
  return new Promise((resolve, reject) => {
    autocannon(
      {
        url: `http://127.0.0.1:${port}/ping`,
        connections: CONNECTIONS,
        duration: DURATION_SEC,
      },
      (err, result) => (err ? reject(err) : resolve(result)),
    )
  })
}

async function runScenario(name: string, moduleClass: unknown, port: number) {
  const app = await NestFactory.create(moduleClass as never, { logger: false })
  await app.listen(port)
  const result = await runOne(port)
  await app.close()
  return { name, result }
}

function pad(s: string, n: number) {
  return s.padEnd(n)
}
function fmt(n: number, w = 8) {
  return n.toFixed(2).padStart(w)
}

async function main() {
  process.stderr.write(`\nbench: ${CONNECTIONS} connections, ${DURATION_SEC}s per run\n\n`)

  const scenarios = [
    await runScenario('bare-nest', BareModule, PORT_BASE),
    await runScenario('nest+pino', PinoOnlyModule, PORT_PINO),
    await runScenario('nest+pino+canonical', CanonicalModule, PORT_CANONICAL),
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

  // Deltas relative to the pino-only baseline (the realistic comparison).
  const pinoOnly = scenarios[1]!.result
  const canonical = scenarios[2]!.result
  const rpsDelta =
    ((canonical.requests.average - pinoOnly.requests.average) / pinoOnly.requests.average) * 100
  const p99Delta = canonical.latency.p99 - pinoOnly.latency.p99

  process.stderr.write(
    `\nadding canonical to pino-only: ${rpsDelta.toFixed(1)}% req/s, +${p99Delta.toFixed(2)} ms p99\n\n`,
  )
}

main().catch(err => {
  process.stderr.write(`bench failed: ${String(err)}\n`)
  process.exit(1)
})
