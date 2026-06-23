import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
} from '@nestjs/common'
import type { Observable } from 'rxjs'
import { finalize, tap } from 'rxjs/operators'
import type { CanonicalHttpAdapter } from './canonical-log.adapter'
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
    // Overwrite the raw path seeded by middleware with the parameterized route
    // template now that NestJS has resolved the handler.
    const route = this.adapter.getRoutePath(req) ?? this.adapter.getRawPath(req)
    this.svc.addFields({ 'http.route': route })

    // Track whether the observable errored. finalize() fires before the
    // exception filter in NestJS's execution order, so we must NOT drain here
    // on the error path — the filter enriches the bag with error fields first.
    let hasError = false

    return next.handle().pipe(
      tap({ error: () => { hasError = true } }),
      finalize(() => {
        if (!hasError) {
          const res = context.switchToHttp().getResponse<{ statusCode: number }>()
          this.svc.addFields({
            'http.response.status_code': res.statusCode,
            duration_ms: this.svc.elapsedMs(),
            outcome: 'ok',
          })
          this.svc.drain()
        }
        // Error path: CanonicalLogExceptionFilter drains after enriching.
      }),
    )
  }
}
