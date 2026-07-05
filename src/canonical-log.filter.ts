import { ArgumentsHost, Catch, HttpException, HttpStatus, Inject } from '@nestjs/common'
import { BaseExceptionFilter } from '@nestjs/core'
import type { CanonicalHttpAdapter } from './canonical-log.adapter'
import { CanonicalLogService } from './canonical-log.service'
import { CANONICAL_HTTP_ADAPTER } from './canonical-log.types'

/**
 * Enriches the canonical record with error fields then emits the line.
 * Extends BaseExceptionFilter to reuse Nest's default response handling
 * (HttpException body preservation, http-errors compat, headers-sent guard,
 * unknown-error logging).
 */
@Catch()
export class CanonicalLogExceptionFilter extends BaseExceptionFilter {
  constructor(
    private readonly svc: CanonicalLogService,
    @Inject(CANONICAL_HTTP_ADAPTER) private readonly adapter: CanonicalHttpAdapter,
  ) {
    super()
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    // HTTP-only. For WebSocket/RPC, rethrow so downstream handlers see the exception.
    if (host.getType() !== 'http') {
      throw exception
    }

    const req = host.switchToHttp().getRequest<unknown>()

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR

    const errorMessage =
      exception instanceof HttpException
        ? (() => {
          const response = exception.getResponse()
          if (typeof response === 'string') return response
          if (typeof response === 'object' && response !== null) {
            const r = response as Record<string, unknown>
            if (typeof r['message'] === 'string') return r['message']
          }
          return exception.message
        })()
        : exception instanceof Error
          ? exception.message
          : String(exception)

    // Ensure http.route is set even for unmatched routes (404s skip the
    // interceptor entirely since no handler is resolved for them).
    const route = this.adapter.getRoutePath(req) ?? this.adapter.getRawPath(req)

    this.svc.addFields({
      'http.route': route,
      'http.response.status_code': status,
      duration_ms: this.svc.elapsedMs(),
      outcome: 'error',
      // error.type (class name) is bounded i.e. has low cardinality. This is the queryable dimension.
      // error.message is free text. It is contextual only, shouldn't be used for querying.
      // error.stack is deliberately omitted to avoid leaking sensitive info into logs.
      'error.type':
        exception instanceof Error
          ? exception.constructor.name
          : typeof exception,
      'error.message': errorMessage,
    })

    this.svc.flush()

    // Must come after flush() so the canonical line is emitted before the
    // response is sent. So it's guaranteed to have the Correlation-ID header if the logger is configured to include it.
    super.catch(exception, host)
  }
}
