import type { CanonicalHttpAdapter } from './canonical-log.adapter'

// ---------------------------------------------------------------------------
// Framework fields — set by the canonical-log mechanism, never by callers.
// Names follow OTEL semantic conventions so fields port directly to spans
// if you switch from log-based to trace-based observability in the future.
// Ref: https://opentelemetry.io/docs/specs/semconv/http/http-spans/
// ---------------------------------------------------------------------------
export interface FrameworkFields {
  /** ISO-8601 timestamp captured at the moment the request arrived. */
  timestamp: string

  /**
   * Logical name of the service emitting the log.
   */
  'service.name': string

  /**
   * Runtime environment label (e.g. "prod", "staging", "dev").
   */
  'deployment.environment'?: string

  /**
   * HTTP verb in uppercase (e.g. "GET", "POST", "PATCH").
   */
  'http.request.method': string

  /**
   * Parameterized route template, not the actual URL.
   * e.g. "/v1/jobs/:id" not "/v1/jobs/abc123".
   * Seeded with the raw path by middleware; overwritten with the template
   * by the interceptor once NestJS has resolved the handler.
   */
  'http.route': string

  /**
   * HTTP response status code (e.g. 200, 404, 500).
   * NOTE: do NOT use a top-level "status" key — Datadog treats it as log severity.
   */
  'http.response.status_code'?: number

  /** Wall-clock milliseconds from request arrival to response (or error). */
  duration_ms?: number

  /**
   * Coarse outcome of the request.
   * "ok"    — handler completed and a non-5xx response was sent.
   * "error" — an exception was thrown (guard, pipe, controller, or filter).
   * Not an OTEL concept; kept for cheap Datadog faceting without a custom parser.
   */
  outcome?: 'ok' | 'error'

  /**
   * The exception / error type name, e.g. "NotFoundException", "QueryTimeoutError".
   * Only present when outcome is "error".
   */
  'error.type'?: string

  /**
   * The exception message string.
   * Only present when outcome is "error".
   */
  'error.message'?: string
}

// ---------------------------------------------------------------------------
// Kernel fields — shared identity present on (nearly) every request.
// ---------------------------------------------------------------------------
export interface DefaultKernelFields {
  /**
   * The resolved tenant / account identifier for this request.
   * Optional: health checks, public webhooks, and auth failures
   * legitimately have no tenant.
   */
  tenant_id?: string

  /**
   * The resolved user / service-account identifier for this request.
   * Optional for the same reasons as tenant_id.
   */
  actor_id?: string

  /**
   * The category of principal making the request.
   * e.g. "human" (end-user session), "api_key" (programmatic), "service" (internal).
   * Optional for the same reasons as tenant_id.
   */
  actor_type?: string
}

// ---------------------------------------------------------------------------
// Module options
// ---------------------------------------------------------------------------
export interface CanonicalLogOptions {
  /**
   * Logical name of the service (e.g. "payments-api").
   * Emitted as "service.name" following OTEL conventions.
   */
  service: string

  /**
   * Runtime environment label (e.g. "prod", "staging").
   * Emitted as "deployment.environment" following OTEL conventions.
   */
  env?: string

  /**
   * Custom logger implementation. Defaults to PinoCanonicalLogger (nestjs-pino).
   * Provide this to use a different sink (Winston, console, custom pipeline)
   * without changing anything else.
   *
   * @example
   * class MyLogger implements ICanonicalLogger {
   *   info(fields: Record<string, unknown>, message: string) {
   *     winston.info(message, fields)
   *   }
   * }
   * CanonicalLogModule.forRoot({ service: 'my-api', logger: new MyLogger() })
   */
  logger?: ICanonicalLogger

  /**
   * TTL in milliseconds for a bag in the CLS store.
   * If flush() is never called (hung request, uncaught exception outside
   * NestJS's filter chain), the bag is automatically evicted after this
   * duration and the activeBags counter is decremented.
   * Default: 30_000 (30 seconds). Set to 0 to disable.
   *
   * How to pick this number:
   * Set it above your p99.9 request latency — the slowest 1-in-1000 request
   * you see in production — plus ~50% headroom. This ensures legitimately
   * slow requests complete and flush() normally before the TTL fires.
   * Setting it too low evicts slow-but-valid requests and silently drops
   * their canonical lines. Setting it too high increases how long a leaked
   * bag holds its slot in the store before being reclaimed.
   *
   * To find your p99.9: query your APM or existing request logs for the
   * maximum `duration_ms` (or pino-http's `responseTime`) over the last
   * 30 days. Add 50% headroom. Example: worst request = 8s → set 12_000.
   */
  bagTtlMs?: number

  /**
   * Hard cap on the number of concurrent active bags in the CLS store.
   * When this limit is reached, new requests are shed: initialize() skips
   * bag creation, addFields() and flush() become no-ops for that request.
   * The request itself is completely unaffected — only the canonical line
   * is lost. Prevents the CLS store from growing unboundedly under load.
   *
   * Default: 5000. Set to 0 to disable.
   */
  maxActiveBags?: number

  /**
   * HTTP adapter for platform-specific request inspection.
   * Defaults to ExpressAdapter. Pass FastifyAdapter when using
   * @nestjs/platform-fastify, or implement CanonicalHttpAdapter for custom platforms.
   *
   * @example
   * import { FastifyAdapter } from 'nestjs-canonical-log'
   * CanonicalLogModule.forRoot({ service: 'my-api', adapter: new FastifyAdapter() })
   */
  adapter?: CanonicalHttpAdapter
}

// ---------------------------------------------------------------------------
// Internal bag — stored in CLS per request.
// ---------------------------------------------------------------------------

/** CLS store key for the canonical bag. Prefixed to avoid collisions with other CLS users. */
export const CANONICAL_LOG_BAG_KEY = '__nestjs_canonical_log__'

/** DI token for CanonicalLogOptions registered via forRoot(). */
export const CANONICAL_LOG_OPTIONS = Symbol('CANONICAL_LOG_OPTIONS')

/** DI token for the CanonicalHttpAdapter registered via forRoot(). */
export const CANONICAL_HTTP_ADAPTER = Symbol('CANONICAL_HTTP_ADAPTER')

/**
 * Minimal logger interface the service depends on.
 * Decouples the service from nestjs-pino — any logger that implements
 * this can be used. The default implementation is PinoCanonicalLogger.
 */
export interface ICanonicalLogger {
  info(fields: Record<string, unknown>, message: string): void
}

/** DI token for the ICanonicalLogger registered by the module. */
export const CANONICAL_LOGGER = Symbol('CANONICAL_LOGGER')

/**
 * Internal tracking fields carried alongside user-visible fields in the CLS bag.
 *
 * Double underscore (__) rather than single (_) is intentional:
 * - Single _ is the JS/TS convention for "unused variable" (e.g. `_res`, `_e`).
 *   Using it here would visually collide with the destructure-alias pattern
 *   that strips these fields before emit: `const { __emitted: _e, ... } = bag`.
 * - Double __ signals "internal implementation detail of the bag mechanism" —
 *   a stronger visual separator from both unused-variable aliases and domain fields.
 *
 * A future improvement would use Symbol keys instead, which are excluded from
 * object spread automatically and cannot be accidentally overwritten by callers.
 */
export interface CanonicalBagMeta {
  /** True once flush() has fired. Prevents the line from being emitted twice. */
  __emitted: boolean

  /** Start time from process.hrtime.bigint(), used to compute duration_ms. */
  __startedAt: bigint

  /**
   * TTL timer handle. Set in initialize(), cancelled in flush().
   * If flush() never fires (hung request, process crash mid-flight),
   * the timer fires and decrements activeBags to prevent counter leak.
   * The timer callback uses a closure reference to the bag — NOT getCls() —
   * because it fires outside the original async context.
   */
  __ttlTimer: ReturnType<typeof setTimeout> | undefined
}

/**
 * The in-flight bag living in CLS for the duration of one HTTP request.
 *
 * Framework and kernel fields are typed; domain fields are an open record.
 * Modules contribute typed partials via addFields<T>() — their local type
 * provides call-site safety, but the bag itself cannot enumerate every
 * domain namespace statically (that would couple it to all modules).
 *
 * Sparseness is intentional: a failed request will have gaps (e.g. no
 * "job.status_to" if the write never completed). Those gaps are signal.
 */
export type CanonicalBag = Partial<FrameworkFields> &
  Partial<DefaultKernelFields> &
  CanonicalBagMeta &
  Record<string, unknown>
