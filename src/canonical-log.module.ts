import {
  DynamicModule,
  Global,
  MiddlewareConsumer,
  Module,
  NestModule,
} from '@nestjs/common'
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core'
import { PinoLogger } from 'nestjs-pino'
import { ExpressAdapter } from './canonical-log.adapter'
import { CanonicalLogExceptionFilter } from './canonical-log.filter'
import { CanonicalLogInterceptor } from './canonical-log.interceptor'
import { PinoCanonicalLogger } from './canonical-log.logger'
import { CanonicalLogMiddleware } from './canonical-log.middleware'
import { CanonicalLogService } from './canonical-log.service'
import {
  CANONICAL_HTTP_ADAPTER,
  CANONICAL_LOG_OPTIONS,
  CANONICAL_LOGGER,
  type CanonicalLogOptions,
  type DefaultKernelFields,
} from './canonical-log.types'

@Global()
@Module({})
export class CanonicalLogModule implements NestModule {
  /**
   * Register the canonical-log module globally.
   *
   * The TKernel type parameter documents which kernel fields your app
   * contributes. It defaults to DefaultKernelFields (tenant_id, actor_id).
   * This is a compile-time hint only — it has no runtime effect.
   *
   * Prerequisites (must be set up in the host AppModule before this module):
   *  - ClsModule.forRoot({ global: true, middleware: { mount: true } })
   *  - LoggerModule.forRoot(...) from nestjs-pino
   *  - dd-trace with logInjection: true for Datadog trace correlation (optional)
   *
   * @example
   * // Express (default)
   * CanonicalLogModule.forRoot({ service: 'my-api', env: process.env.NODE_ENV })
   *
   * // Fastify
   * import { FastifyAdapter } from 'nestjs-canonical-log'
   * CanonicalLogModule.forRoot({ service: 'my-api', adapter: new FastifyAdapter() })
   */
  static forRoot<_TKernel = DefaultKernelFields>(
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
        // If the consumer supplies a custom logger, wire it directly as a value.
        // Otherwise use the factory so PinoLogger is resolved from the DI container
        // (nestjs-pino must be set up by the consumer as a peer dep).
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
