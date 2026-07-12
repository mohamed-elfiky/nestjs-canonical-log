import type { CanonicalHttpAdapter } from './adapters/http-adapter'

// ---------------------------------------------------------------------------
// Framework fields. Set by the library, don't override.
// ---------------------------------------------------------------------------
export interface FrameworkFields {
  /** When the request came in. ISO-8601. */
  timestamp: string

  /** Name of your service. */
  'service.name': string

  /** Which environment this is running in (prod, staging, dev). */
  'deployment.environment'?: string

  /** GET, POST, PATCH, etc. */
  'http.request.method': string

  /**
   * The route template, not the actual URL.
   * e.g. "/v1/jobs/:id" — not "/v1/jobs/abc123".
   */
  'http.route': string

  /** 200, 404, 500, etc. */
  'http.response.status_code'?: number

  /** Controller class name, e.g. "JobsController". Absent on unmatched routes. */
  'code.namespace'?: string

  /** Handler method name, e.g. "updateStatus". Absent on unmatched routes. */
  'code.function'?: string

  /** How long the request took, in milliseconds. */
  duration_ms?: number

  /**
   * How the request ended.
   *  - "ok"       handler completed and a response was sent
   *  - "error"    something threw
   *  - "timeout"  TTL expired before flush; emitted anyway so hung requests stay visible
   *  - "shutdown" app shut down with the request still in flight
   */
  outcome?: 'ok' | 'error' | 'timeout' | 'shutdown'

  /** The exception class name (e.g. "QueryTimeoutError"). Only on errors. */
  'error.type'?: string

  /** The exception message. Only on errors. */
  'error.message'?: string

  /**
   * Where the request was when the line was emitted. Always present.
   * The library initializes it to "request_started" at the start of every
   * request. Update it as work progresses via canonicalLog.stage(name).
   * Terminal value on a failed line points at where the request stopped.
   *
   * Recommended:
   *  Keep the set of values small (< ~50 per handler) to preserve queryability.
   *  Enforce a stage enum at compile time using a local union type:
   *
   *    type JobStage = 'fetching_job' | 'writing_status' | 'notifying' | 'done'
   *    canonicalLog.stage<JobStage>('fetching_job')
   */
  stage: string
}

// ---------------------------------------------------------------------------
// Shared fields — concerns that show up on (almost) every request.
// ---------------------------------------------------------------------------
export interface DefaultSharedFields {
  /** Which tenant/account this request belongs to. */
  tenant_id?: string

  /** Which user or service account made the request. */
  actor_id?: string

  /** What kind of principal made the request (human, api_key, service). */
  actor_type?: string
}

// ---------------------------------------------------------------------------
// Module options — passed to CanonicalLogModule.forRoot({...}).
// ---------------------------------------------------------------------------
export interface CanonicalLogOptions {
  /** Name of your service. Same key you'll search for in your logs. */
  'service.name': string

  /** Environment name (prod, staging, dev). Optional. */
  'deployment.environment'?: string

  /**
   * Your own logger. Defaults to nestjs-pino.
   * Implement ICanonicalLogger if you want to swap sinks (Winston, console, etc).
   */
  logger?: ICanonicalLogger

  /**
   * How long (ms) a request can stay in-flight before we emit `outcome: 'timeout'`.
   * Set above your p99.9 with some headroom — too low drops slow-but-valid
   * requests. Default: 30_000, minimum 1_000 (the TTL is the memory bound for
   * in-flight records, so it can't be disabled).
   *
   * Timeouts are checked by a single recurring sweep (see sweepIntervalMs),
   * not per-request timers, so actual eviction can be up to sweepIntervalMs
   * late (worst case: recordTtlMs + sweepIntervalMs).
   */
  recordTtlMs?: number

  /**
   * How often (ms) the timeout sweep runs. Only active while there are
   * in-flight records; stops itself when the app goes idle.
   * Default: 5_000, minimum 1_000.
   */
  sweepIntervalMs?: number

  /**
   * HTTP adapter. Defaults to Express. Use FastifyAdapter for Fastify, or
   * write your own by implementing CanonicalHttpAdapter.
   */
  adapter?: CanonicalHttpAdapter
}

// ---------------------------------------------------------------------------
// Internal — the record that holds fields during a request's lifetime.
// ---------------------------------------------------------------------------

/** Where in CLS we store the record. */
export const CANONICAL_LOG_RECORD_KEY: unique symbol = Symbol('canonical.record')

// Symbol keys for internal record state. Unexported at the package level so
// callers can't overwrite them via addFields(). Symbols are also skipped by
// JSON.stringify, so they naturally don't show up in the emitted line.
export const EMITTED: unique symbol = Symbol('canonical.emitted')
export const STARTED_AT: unique symbol = Symbol('canonical.startedAt')

/** DI token for the options object. */
export const CANONICAL_LOG_OPTIONS = Symbol('CANONICAL_LOG_OPTIONS')

/** DI token for the HTTP adapter. */
export const CANONICAL_HTTP_ADAPTER = Symbol('CANONICAL_HTTP_ADAPTER')

/**
 * What the library needs from a logger. Two args, one method — that's it.
 * Pass your own to forRoot({ logger }) to plug in a different sink.
 */
export interface ICanonicalLogger {
  info(fields: Record<string, unknown>, message: string): void
}

/** DI token for the logger. */
export const CANONICAL_LOGGER = Symbol('CANONICAL_LOGGER')

/**
 * Internal bookkeeping fields. Kept on the record under Symbol keys so callers
 * can't touch them and they don't leak into the emitted JSON.
 */
export interface CanonicalRecordMeta {
  /** True after flush() runs. Keeps the line from being emitted twice. */
  [EMITTED]: boolean

  /** When the request started (hrtime), used to compute duration_ms. */
  [STARTED_AT]: bigint
}

/**
 * The record itself: framework + shared + your domain fields + internal state.
 * Domain fields are open — type them locally at the call site via addFields<T>().
 */
export type CanonicalRecord = Partial<FrameworkFields> &
  Partial<DefaultSharedFields> &
  CanonicalRecordMeta &
  Record<string, unknown>
