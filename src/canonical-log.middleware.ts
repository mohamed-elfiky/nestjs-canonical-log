import { Inject, Injectable, NestMiddleware } from '@nestjs/common'
import type { CanonicalHttpAdapter } from './adapters/http-adapter'
import { CanonicalLogService } from './canonical-log.service'
import { CANONICAL_HTTP_ADAPTER } from './canonical-log.types'

@Injectable()
export class CanonicalLogMiddleware implements NestMiddleware {
  constructor(
    private readonly svc: CanonicalLogService,
    @Inject(CANONICAL_HTTP_ADAPTER) private readonly adapter: CanonicalHttpAdapter,
  ) {}

  use(req: unknown, _res: unknown, next: () => void): void {
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
