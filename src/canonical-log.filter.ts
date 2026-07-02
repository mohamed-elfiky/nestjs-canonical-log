import { ArgumentsHost, Catch, HttpException, HttpStatus, Inject } from '@nestjs/common'
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core'
import type { CanonicalHttpAdapter } from './canonical-log.adapter'
import { CanonicalLogService } from './canonical-log.service'
import { CANONICAL_HTTP_ADAPTER } from './canonical-log.types'

/**
 * Enriches the canonical bag with error fields then emits the line.
 *
 * Why extend BaseExceptionFilter instead of implementing ExceptionFilter directly:
 *
 * BaseExceptionFilter is NestJS's built-in default handler. It knows how to
 * turn any exception into a well-formed HTTP response — correct status codes,
 * response body shape, header handling, and platform differences (Express vs
 * Fastify). Reimplementing that from scratch would be brittle and duplicate
 * framework internals.
 *
 * By extending it, we get a clean two-step separation:
 *   1. Our catch() — observability only: enrich bag, flush canonical line.
 *   2. super.catch() — response only: let NestJS send the HTTP error response.
 *
 * If we skipped super.catch(), the exception would be swallowed: no response
 * would ever be sent to the client and the request would hang indefinitely.
 *
 * Why @Catch() with no arguments:
 * Catches ALL exceptions — HttpException, native Error, thrown strings, etc.
 * This is intentional: failure-correctness requires the canonical line to emit
 * regardless of what was thrown, including guard failures, pipe validation
 * errors, and unexpected non-Error throws.
 */
@Catch()
export class CanonicalLogExceptionFilter extends BaseExceptionFilter {
  /**
   * HttpAdapterHost provides the underlying HTTP adapter (Express or Fastify)
   * that BaseExceptionFilter needs to send the error response.
   * NestJS injects it automatically when the filter is registered via APP_FILTER.
   */
  constructor(
    private readonly svc: CanonicalLogService,
    @Inject(CANONICAL_HTTP_ADAPTER) private readonly adapter: CanonicalHttpAdapter,
    adapterHost: HttpAdapterHost,
  ) {
    super(adapterHost.httpAdapter)
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() === 'http') {
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
        'error.type':
          exception instanceof Error
            ? exception.constructor.name
            : typeof exception,
        'error.message': errorMessage,
      })

      // flush() is idempotent — if the interceptor's finalize() somehow already
      // fired (edge case), this is a safe no-op.
      this.svc.flush()
    }

    // Hand off to BaseExceptionFilter to send the actual HTTP error response.
    // This MUST come after flush() so the canonical line is emitted before the
    // response is sent — order matters for log correlation in Datadog.
    super.catch(exception, host)
  }
}
