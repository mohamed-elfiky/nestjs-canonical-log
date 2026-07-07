import { Inject, Injectable, Logger, NestMiddleware } from '@nestjs/common'
import { ClsService } from 'nestjs-cls'
import type { CanonicalHttpAdapter } from './adapters/http-adapter'
import { CanonicalLogService } from './canonical-log.service'
import { CANONICAL_HTTP_ADAPTER } from './canonical-log.types'

@Injectable()
export class CanonicalLogMiddleware implements NestMiddleware {
  private readonly nestLogger = new Logger('CanonicalLog')
  private warnedNoCls = false

  constructor(
    private readonly svc: CanonicalLogService,
    private readonly cls: ClsService,
    @Inject(CANONICAL_HTTP_ADAPTER) private readonly adapter: CanonicalHttpAdapter,
  ) {}

  use(req: unknown, _res: unknown, next: () => void): void {
    // Without an active CLS context every addFields/flush silently no-ops and
    // zero canonical lines are emitted. That's a misconfiguration, not a
    // runtime condition — surface it loudly once instead of failing silently.
    if (!this.cls.isActive()) {
      if (!this.warnedNoCls) {
        this.warnedNoCls = true
        this.nestLogger.warn(
          'No active CLS context — canonical logs are disabled. ' +
            'Mount ClsModule.forRoot({ global: true, middleware: { mount: true } }) ' +
            'BEFORE CanonicalLogModule in your AppModule imports.',
        )
      }
      return next()
    }

    this.svc.initialize()
    // Seed with raw path as a fallback for http.route. For matched routes the
    // interceptor will overwrite this with the parameterized template.
    const method = (req as { method?: string }).method
    this.svc.addFields({
      'http.request.method': method,
      'http.route': this.adapter.getRawPath(req),
    })
    next()
  }
}
