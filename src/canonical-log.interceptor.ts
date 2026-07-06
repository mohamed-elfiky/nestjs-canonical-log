import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from '@nestjs/common'
import { finalize, tap, type Observable } from 'rxjs'
import type { CanonicalHttpAdapter } from './adapters/http-adapter'
import { CanonicalLogService } from './canonical-log.service'
import { CANONICAL_HTTP_ADAPTER } from './canonical-log.types'

@Injectable()
export class CanonicalLogInterceptor implements NestInterceptor {
  constructor(
    private readonly svc: CanonicalLogService,
    @Inject(CANONICAL_HTTP_ADAPTER) private readonly adapter: CanonicalHttpAdapter,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle()

    const req = context.switchToHttp().getRequest<unknown>()
    // The raw path from middleware (e.g. "/users/123") is high-cardinality —
    // useless as a query dimension. Now that the handler has resolved,
    // overwrite with the parameterized template (e.g. "/users/:id").
    const route = this.adapter.getRoutePath(req) ?? this.adapter.getRawPath(req)
    this.svc.addFields({ 'http.route': route })

    // finalize() fires before the exception filter, so on the error path we
    // skip flushing here and let the filter do it after enriching.
    let hasError = false

    return next.handle().pipe(
      tap({
        error: () => {
          hasError = true
        },
      }),
      finalize(() => {
        if (!hasError) {
          const res = context.switchToHttp().getResponse<{ statusCode: number }>()
          this.svc.addFields({
            'http.response.status_code': res.statusCode,
            duration_ms: this.svc.elapsedMs(),
            outcome: 'ok',
          })
          this.svc.flush()
        }
        // Error path: filter flushes.
      }),
    )
  }
}
