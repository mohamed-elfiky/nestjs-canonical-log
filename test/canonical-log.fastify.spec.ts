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
import { FastifyAdapter as NestFastifyAdapter } from '@nestjs/platform-fastify'
import { ClsModule } from 'nestjs-cls'
import 'reflect-metadata'
import { CanonicalLogModule, CanonicalLogService, type ICanonicalLogger } from '../src/index'
import { FastifyAdapter } from '../src/adapters/fastify.adapter'

type LogRecord = Record<string, unknown> & { msg: string }

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

@Injectable()
class JobsService {
  constructor(private readonly canonicalLog: CanonicalLogService) {}

  getOne(id: string) {
    this.canonicalLog.addFields({ 'job.id': id, 'job.status_from': 'scheduled' })
    if (id === 'not-found') {
      throw new HttpException('job not found', HttpStatus.NOT_FOUND)
    }
    return { id, status: 'scheduled' }
  }

  updateStatus(id: string, next: string) {
    this.canonicalLog.addFields({ 'job.id': id, 'job.status_from': 'scheduled' })
    if (next === 'boom') {
      throw new TypeError('unexpected status transition')
    }
    this.canonicalLog.addFields({ 'job.status_to': next })
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
  update(@Param('id') id: string, @Body() body: { status: string }) {
    return this.jobs.updateStatus(id, body.status)
  }
}

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

function makeSampleModule(logger: ICanonicalLogger) {
  @Module({
    imports: [
      ClsModule.forRoot({ global: true, middleware: { mount: true } }),
      CanonicalLogModule.forRoot({
        'service.name': 'test-service',
        logger,
        adapter: new FastifyAdapter(),
      }),
      AuthModule,
    ],
    controllers: [JobsController],
    providers: [JobsService],
  })
  class TestAppModule {}
  return TestAppModule
}

async function bootstrap(logger: ICanonicalLogger): Promise<INestApplication> {
  const TestAppModule = makeSampleModule(logger)
  const app = await NestFactory.create(TestAppModule, new NestFastifyAdapter(), {
    logger: false,
    abortOnError: false,
  })
  await app.init()
  // Fastify needs an explicit ready() so its own router is populated.
  await (app.getHttpAdapter().getInstance() as { ready: () => Promise<void> }).ready()
  return app
}

// Fastify test uses fastify.inject() rather than supertest — it's the native
// zero-network test harness and matches how Fastify apps are actually tested.
function injectRequest(app: INestApplication) {
  const fastify = app.getHttpAdapter().getInstance() as {
    inject: (opts: { method: string; url: string; payload?: unknown }) => Promise<{
      statusCode: number
      payload: string
    }>
  }
  return fastify.inject.bind(fastify)
}

describe('CanonicalLog — Fastify adapter', () => {
  let app: INestApplication
  let logs: LogRecord[]
  let inject: ReturnType<typeof injectRequest>

  beforeEach(async () => {
    const { logs: l, logger } = makeCapturingLogger()
    logs = l
    app = await bootstrap(logger)
    inject = injectRequest(app)
  })

  afterEach(async () => {
    await app.close()
  })

  it('emits one canonical line for a successful request with parameterized route', async () => {
    const res = await inject({ method: 'GET', url: '/jobs/job_1' })
    expect(res.statusCode).toBe(200)
    expect(logs).toHaveLength(1)
    const line = logs[0]!
    expect(line['service.name']).toBe('test-service')
    expect(line['http.request.method']).toBe('GET')
    expect(line['http.route']).toBe('/jobs/:id')
    expect(line['http.response.status_code']).toBe(200)
    expect(line['outcome']).toBe('ok')
    expect(line['tenant_id']).toBe('acct_test')
    expect(line['job.id']).toBe('job_1')
  })

  it('emits a canonical line for HttpException with error fields', async () => {
    const res = await inject({ method: 'GET', url: '/jobs/not-found' })
    expect(res.statusCode).toBe(404)
    expect(logs).toHaveLength(1)
    const line = logs[0]!
    expect(line['outcome']).toBe('error')
    expect(line['http.response.status_code']).toBe(404)
    expect(line['error.type']).toBe('HttpException')
  })

  it('captures non-HttpException throws and preserves domain-field sparseness', async () => {
    const res = await inject({
      method: 'POST',
      url: '/jobs/job_1/status',
      payload: { status: 'boom' },
    })
    expect(res.statusCode).toBe(500)
    const line = logs[0]!
    expect(line['outcome']).toBe('error')
    expect(line['error.type']).toBe('TypeError')
    expect(line['job.id']).toBe('job_1')
    expect(line['job.status_from']).toBe('scheduled')
    expect(line['job.status_to']).toBeUndefined()
  })

  it('emits a canonical line for unmatched routes (404) with the raw path', async () => {
    const res = await inject({ method: 'GET', url: '/does-not-exist' })
    expect(res.statusCode).toBe(404)
    expect(logs).toHaveLength(1)
    const line = logs[0]!
    expect(line['outcome']).toBe('error')
    expect(line['http.response.status_code']).toBe(404)
    expect(line['http.route']).toBe('/does-not-exist')
  })

  it('strips the query string from http.route via FastifyAdapter.getRawPath', async () => {
    const res = await inject({ method: 'GET', url: '/does-not-exist?verbose=1&tag=x' })
    expect(res.statusCode).toBe(404)
    const line = logs[0]!
    expect(line['http.route']).toBe('/does-not-exist')
  })
})
