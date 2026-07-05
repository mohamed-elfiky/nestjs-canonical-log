import {
  DynamicModule,
  Global,
  MiddlewareConsumer,
  Module,
  NestModule,
} from '@nestjs/common'
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core'
import { PinoLogger } from 'nestjs-pino'
import { ExpressAdapter } from './adapters/express.adapter'
import { CanonicalLogExceptionFilter } from './canonical-log.filter'
import { CanonicalLogInterceptor } from './canonical-log.interceptor'
import { PinoCanonicalLogger } from './loggers/pino.logger'
import { CanonicalLogMiddleware } from './canonical-log.middleware'
import { CanonicalLogService } from './canonical-log.service'
import {
  CANONICAL_HTTP_ADAPTER,
  CANONICAL_LOG_OPTIONS,
  CANONICAL_LOGGER,
  type CanonicalLogOptions,
  type DefaultSharedFields,
} from './canonical-log.types'

@Global()
@Module({})
export class CanonicalLogModule implements NestModule {
  /**
   * Register the canonical-log module globally.
   *
   * The TShared type parameter documents which shared fields your app
   * contributes. It defaults to DefaultSharedFields (tenant_id, actor_id).
   *
   * Prerequisites (must be set up in the host AppModule before this module):
   *  - ClsModule.forRoot({ global: true, middleware: { mount: true } })
   *  - LoggerModule.forRoot(...) for your chosen logger (nestjs-pino, Winston, etc)
   *  - Recommended: Use auto-instrumentation to inject correlation IDs into your logs (e.g. OpenTelemetry, Datadog, etc)
   *
   * @example
   * // Express (default)
   * CanonicalLogModule.forRoot({
   *   'service.name': 'my-api',
   *   'deployment.environment': process.env.NODE_ENV,
   * })
   *
   * // Fastify
   * import { FastifyAdapter } from 'nestjs-canonical-log'
   * CanonicalLogModule.forRoot({ 'service.name': 'my-api', adapter: new FastifyAdapter() })
   */
  static forRoot<_TShared = DefaultSharedFields>(
    options: CanonicalLogOptions,
  ): DynamicModule {
    return {
      global: true,
      module: CanonicalLogModule,
      providers: [
        {
          provide: CANONICAL_LOG_OPTIONS,
          useValue: options,
        },
        {
          provide: CANONICAL_HTTP_ADAPTER,
          useValue: options.adapter ?? new ExpressAdapter(),
        },
        // Custom logger → use it directly. Otherwise resolve PinoLogger from DI.
        options.logger
          ? { provide: CANONICAL_LOGGER, useValue: options.logger }
          : {
            provide: CANONICAL_LOGGER,
            useFactory: (pino: PinoLogger) => new PinoCanonicalLogger(pino),
            inject: [PinoLogger],
          },
        CanonicalLogService,
        {
          provide: APP_INTERCEPTOR,
          useClass: CanonicalLogInterceptor,
        },
        {
          provide: APP_FILTER,
          useClass: CanonicalLogExceptionFilter,
        },
      ],
      exports: [CanonicalLogService],
    }
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CanonicalLogMiddleware).forRoutes('*')
  }
}
