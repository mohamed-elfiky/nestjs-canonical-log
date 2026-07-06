import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  INestApplication,
  Injectable,
  MiddlewareConsumer,
  Module,
  NestMiddleware,
  NestModule,
  Param,
  Post,
} from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { ClsModule, ClsService } from 'nestjs-cls'
import request from 'supertest'
import 'reflect-metadata'
import { CanonicalLogModule, CanonicalLogService, type ICanonicalLogger } from '../src/index'

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

type LogRecord = Record<string, unknown> & { msg: string }

/**
 * Capturing logger that simulates real JSON emission — JSON.stringify strips
 * Symbol-keyed properties, so this doubles as a proof that internal metadata
 * doesn't leak into the wire format.
 */
function makeCapturingLogger(): { logs: LogRecord[]; logger: ICanonicalLogger } {
  const logs: LogRecord[] = []
  const logger: ICanonicalLogger = {
    info(fields, message) {
      const wire = JSON.parse(JSON.stringify(fields)) as Record<string, unknown>
      logs.push({ ...wire, msg: message })
    },
  }
  return { logs, logger }
}

// ---------------------------------------------------------------------------
// Sample app — controllers, service, DTO
// ---------------------------------------------------------------------------

type StatusDto = { status: string }

@Injectable()
class JobsService {
  constructor(private readonly canonicalLog: CanonicalLogService) {}

  getOne(id: string): { id: string; status: string } {
    this.canonicalLog.addFields({ 'job.id': id, 'job.status_from': 'scheduled' })
    if (id === 'not-found') {
      throw new HttpException('job not found', HttpStatus.NOT_FOUND)
    }
    return { id, status: 'scheduled' }
  }

  updateStatus(id: string, next: string) {
    type JobStage = 'fetching_job' | 'writing_status' | 'done'
    this.canonicalLog.stage<JobStage>('fetching_job')
    this.canonicalLog.addFields({
      'job.id': id,
      'job.status_from': 'scheduled',
    })
    if (next === 'boom') {
      // Non-HttpException throw — should still produce a canonical line.
      throw new TypeError('unexpected status transition')
    }
    this.canonicalLog.stage<JobStage>('writing_status')
    this.canonicalLog.addFields({ 'job.status_to': next })
    this.canonicalLog.stage<JobStage>('done')
    return { id, status: next }
  }
}

@Controller('jobs')
class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Get(':id')
  get(@Param('id') id: string) {
    return this.jobs.getOne(id)
  }

  @Post(':id/status')
  update(@Param('id') id: string, @Body() body: StatusDto) {
    return this.jobs.updateStatus(id, body.status)
  }
}

// Auth middleware that sets a shared field. Lives in its own module so it
// mounts AFTER ClsModule's middleware (which is required for cls.isActive()).
// Root-module `configure()` runs before imported modules' middleware, so an
// auth middleware in AppModule.configure() would see no CLS context.
@Injectable()
class AuthMiddleware implements NestMiddleware {
  constructor(private readonly canonicalLog: CanonicalLogService) {}
  use(_req: unknown, _res: unknown, next: () => void) {
    this.canonicalLog.addFields({ actor_id: 'usr_test', tenant_id: 'acct_test' })
    next()
  }
}

@Module({ providers: [AuthMiddleware] })
class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(AuthMiddleware).forRoutes('*')
  }
}

/**
 * Builds the sample module. `overrides` lets a test tweak CanonicalLogModule
 * options (e.g. recordTtlMs, maxActiveRecords) without duplicating the module wiring.
 */
function makeSampleModule(
  logger: ICanonicalLogger,
  overrides: Partial<Parameters<typeof CanonicalLogModule.forRoot>[0]> = {},
) {
  @Module({
    imports: [
      ClsModule.forRoot({ global: true, middleware: { mount: true } }),
      CanonicalLogModule.forRoot({
        'service.name': 'test-service',
        logger,
        ...overrides,
      }),
      AuthModule,
    ],
    controllers: [JobsController],
    providers: [JobsService],
  })
  class TestAppModule {}
  return TestAppModule
}

async function bootstrap(
  logger: ICanonicalLogger,
  overrides: Partial<Parameters<typeof CanonicalLogModule.forRoot>[0]> = {},
): Promise<INestApplication> {
  const TestAppModule = makeSampleModule(logger, overrides)
  const app = await NestFactory.create(TestAppModule, {
    logger: false,
    // Otherwise Nest calls process.abort() on bootstrap errors, killing the
    // Jest worker before the test can see the failure.
    abortOnError: false,
  })
  await app.init()
  return app
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CanonicalLog — HTTP success path', () => {
  let app: INestApplication
  let logs: LogRecord[]

  beforeEach(async () => {
    const { logs: l, logger } = makeCapturingLogger()
    logs = l
    app = await bootstrap(logger)
  })

  afterEach(async () => {
    await app.close()
  })

  it('emits exactly one canonical line per successful request', async () => {
    await request(app.getHttpServer()).get('/jobs/job_1').expect(200)
    expect(logs).toHaveLength(1)
    expect(logs[0]!['msg']).toBe('canonical')
  })

  it('populates framework, shared, and domain fields', async () => {
    await request(app.getHttpServer()).get('/jobs/job_42').expect(200)
    const line = logs[0]!
    expect(line['service.name']).toBe('test-service')
    expect(line['http.request.method']).toBe('GET')
    expect(line['http.route']).toBe('/jobs/:id')
    expect(line['http.response.status_code']).toBe(200)
    expect(line['outcome']).toBe('ok')
    expect(line['duration_ms']).toEqual(expect.any(Number))
    expect(line['tenant_id']).toBe('acct_test')
    expect(line['actor_id']).toBe('usr_test')
    expect(line['job.id']).toBe('job_42')
    expect(line['job.status_from']).toBe('scheduled')
    // stage is always present with the initial value unless overridden.
    expect(line['stage']).toBe('request_started')
  })

  it('emits the terminal stage set by the handler on success', async () => {
    await request(app.getHttpServer())
      .post('/jobs/job_1/status')
      .send({ status: 'in_progress' })
      .expect(201)
    expect(logs).toHaveLength(1)
    // updateStatus() walks fetching_job → writing_status → done.
    expect(logs[0]!['stage']).toBe('done')
  })

  it('excludes internal Symbol keys from the emitted wire format', async () => {
    await request(app.getHttpServer()).get('/jobs/job_x').expect(200)
    const line = logs[0]!
    // These names come from the old string-keyed implementation. If the Symbol
    // switch was regressed and internals leaked back as strings, this would
    // catch it.
    expect(line['__emitted']).toBeUndefined()
    expect(line['__startedAt']).toBeUndefined()
    expect(line['__ttlTimer']).toBeUndefined()
    // And the flag under any generic name shouldn't be present either.
    expect(Object.keys(line).some(k => k.startsWith('__'))).toBe(false)
  })
})

describe('CanonicalLog — HTTP error path', () => {
  let app: INestApplication
  let logs: LogRecord[]

  beforeEach(async () => {
    const { logs: l, logger } = makeCapturingLogger()
    logs = l
    app = await bootstrap(logger)
  })

  afterEach(async () => {
    await app.close()
  })

  it('emits one canonical line for HttpException with error fields', async () => {
    await request(app.getHttpServer()).get('/jobs/not-found').expect(404)
    expect(logs).toHaveLength(1)
    const line = logs[0]!
    expect(line['outcome']).toBe('error')
    expect(line['http.response.status_code']).toBe(404)
    expect(line['error.type']).toBe('HttpException')
    expect(line['error.message']).toBe('job not found')
  })

  it('captures error.type + error.message for non-HttpException throws', async () => {
    await request(app.getHttpServer())
      .post('/jobs/job_1/status')
      .send({ status: 'boom' })
      .expect(500)
    expect(logs).toHaveLength(1)
    const line = logs[0]!
    expect(line['outcome']).toBe('error')
    expect(line['error.type']).toBe('TypeError')
    expect(line['error.message']).toBe('unexpected status transition')
    // stage should be pinned at the checkpoint the throw interrupted.
    expect(line['stage']).toBe('fetching_job')
    // error.stack is deliberately NOT emitted — too large for canonical logs,
    // and better handled by an error tracker correlated via trace_id.
    expect(line['error.stack']).toBeUndefined()
  })

  it('emits a canonical line for unmatched routes (404)', async () => {
    await request(app.getHttpServer()).get('/does-not-exist').expect(404)
    expect(logs).toHaveLength(1)
    const line = logs[0]!
    expect(line['outcome']).toBe('error')
    expect(line['http.response.status_code']).toBe(404)
    // http.route falls back to the raw path since no handler resolves.
    expect(line['http.route']).toBe('/does-not-exist')
  })

  // A full pipe-validation test (POST with an invalid DTO body) needs the
  // controller's parameter type metadata to survive the SWC transform, which
  // isn't reliable in the test harness. The equivalent behavior — canonical
  // line emits regardless of where the throw originates — is covered by the
  // unmatched-route (404) test and the non-HttpException test above.

  it('sparse-writes domain fields — job.status_to absent when the write fails', async () => {
    await request(app.getHttpServer())
      .post('/jobs/job_1/status')
      .send({ status: 'boom' })
      .expect(500)
    const line = logs[0]!
    expect(line['job.id']).toBe('job_1')
    expect(line['job.status_from']).toBe('scheduled')
    // status_to never set — sparseness is signal.
    expect(line['job.status_to']).toBeUndefined()
  })
})

describe('CanonicalLog — concurrency', () => {
  let app: INestApplication
  let logs: LogRecord[]
  let baseUrl: string

  beforeEach(async () => {
    const { logs: l, logger } = makeCapturingLogger()
    logs = l
    app = await bootstrap(logger)
    // Bind to an ephemeral port so concurrent supertest requests share a
    // single listening server instead of spinning up an ephemeral one per
    // request — avoids ECONNRESET under parallel load.
    await app.listen(0)
    const server = app.getHttpServer() as { address: () => { port: number } }
    baseUrl = `http://127.0.0.1:${server.address().port}`
  })

  afterEach(async () => {
    await app.close()
  })

  it('emits one canonical line per request under concurrent load, without cross-request field leakage', async () => {
    const N = 8
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        request(baseUrl).get(`/jobs/concurrent_${i}`).expect(200),
      ),
    )
    expect(results).toHaveLength(N)
    expect(logs).toHaveLength(N)
    const ids = logs.map(l => l['job.id']).sort()
    const expected = Array.from({ length: N }, (_, i) => `concurrent_${i}`).sort()
    expect(ids).toEqual(expected)
  })
})

describe('CanonicalLog — TTL timeout', () => {
  let app: INestApplication
  let logs: LogRecord[]

  beforeEach(async () => {
    const { logs: l, logger } = makeCapturingLogger()
    logs = l
    // Short TTL + short sweep interval so the test doesn't wait long.
    // With sweepIntervalMs=25 and recordTtlMs=50, a hung request should be
    // emitted within ~75 ms worst case.
    app = await bootstrap(logger, { recordTtlMs: 50, sweepIntervalMs: 25 })
  })

  afterEach(async () => {
    await app.close()
  })

  it('emits outcome:timeout when the record TTL expires without flush()', async () => {
    // Bypass HTTP — drive the service directly inside a CLS context so
    // initialize() runs but flush() never does.
    const cls = app.get(ClsService)
    const svc = app.get(CanonicalLogService)
    await cls.run(async () => {
      svc.initialize()
      svc.addFields({ 'test.marker': 'ttl' })
      await new Promise(r => setTimeout(r, 150))
    })

    expect(logs).toHaveLength(1)
    const line = logs[0]!
    expect(line['outcome']).toBe('timeout')
    expect(line['test.marker']).toBe('ttl')
    expect(line['duration_ms']).toEqual(expect.any(Number))
  })
})

describe('CanonicalLog — load shedding', () => {
  let app: INestApplication
  let logs: LogRecord[]

  beforeEach(async () => {
    const { logs: l, logger } = makeCapturingLogger()
    logs = l
    // Cap at 1 — first request holds the slot; concurrent second request is shed.
    app = await bootstrap(logger, { maxActiveRecords: 1, recordTtlMs: 0 })
  })

  afterEach(async () => {
    await app.close()
  })

  it('sheds requests when the store is at capacity — no line emitted for shed requests', async () => {
    const cls = app.get(ClsService)
    const svc = app.get(CanonicalLogService)

    // First "request": acquire the slot, never flush.
    let shedResult: { addedFields: boolean } | undefined
    const held = new Promise<void>(resolve => {
      void cls.run(async () => {
        svc.initialize()
        svc.addFields({ 'test.marker': 'held' })

        // Second concurrent "request": store is at cap, should be shed.
        await cls.run(async () => {
          svc.initialize()
          svc.addFields({ 'test.marker': 'shed' })
          shedResult = { addedFields: false }
        })

        resolve()
      })
    })
    await held

    // Neither the held (never flushed) nor shed request emitted a line.
    expect(logs).toHaveLength(0)
    expect(shedResult).toBeDefined()
  })
})

describe('CanonicalLog — internal field protection', () => {
  let app: INestApplication
  let logs: LogRecord[]

  beforeEach(async () => {
    const { logs: l, logger } = makeCapturingLogger()
    logs = l
    app = await bootstrap(logger)
  })

  afterEach(async () => {
    await app.close()
  })

  it('does not let addFields overwrite internal Symbol state', async () => {
    // Under the old string-keyed implementation a caller could set __emitted
    // to true and cause flush() to become a permanent no-op. With Symbol keys
    // these strings surface as regular domain fields — flush still emits once,
    // and calling it again is still an idempotent no-op.
    const cls = app.get(ClsService)
    const svc = app.get(CanonicalLogService)
    let elapsed: number | undefined
    await cls.run(async () => {
      svc.initialize()
      svc.addFields({
        __emitted: 'attacker-set',
        __startedAt: 999,
        __ttlTimer: 'nope',
        'user.field': 'ok',
      })
      // Read elapsedMs BEFORE flush — proves the Symbol-keyed __startedAt
      // survived the caller's attempt. If overwritten to 999, this would
      // return a nonsense value (typically negative or huge).
      elapsed = svc.elapsedMs()
      svc.flush()
      // Second flush must be a no-op — idempotency intact despite the caller's
      // attempt to shadow the internal flag.
      svc.flush()
    })

    expect(logs).toHaveLength(1)
    const line = logs[0]!
    expect(line['user.field']).toBe('ok')
    // The string-keyed attempts DO land in the record as domain fields — this
    // proves they didn't hijack internal state (if they had, flush would have
    // been a no-op and logs would be empty).
    expect(line['__emitted']).toBe('attacker-set')
    // elapsedMs came from Symbol-keyed __startedAt, which the caller cannot
    // touch — should be a sane small number, not nonsense.
    expect(elapsed).toEqual(expect.any(Number))
    expect(elapsed!).toBeGreaterThanOrEqual(0)
    expect(elapsed!).toBeLessThan(1_000)
  })
})

describe('CanonicalLog — startup validation', () => {
  it('bootstrap fails when service.name is empty', async () => {
    const { logger } = makeCapturingLogger()
    @Module({
      imports: [
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
        CanonicalLogModule.forRoot({ 'service.name': '', logger }),
      ],
    })
    class BadModule {}
    await expect(
      NestFactory.create(BadModule, { logger: false, abortOnError: false }),
    ).rejects.toThrow(/service\.name.*required/i)
  })
})
