import { Inject, Injectable } from '@nestjs/common'
import { ClsService } from 'nestjs-cls'
import {
  CANONICAL_LOG_OPTIONS,
  CANONICAL_LOG_RECORD_KEY,
  CANONICAL_LOG_SHED_KEY,
  CANONICAL_LOGGER,
  EMITTED,
  STARTED_AT,
  TTL_TIMER,
  type CanonicalLogOptions,
  type CanonicalRecord,
  type ICanonicalLogger,
} from './canonical-log.types'

const DEFAULT_MAX_ACTIVE_RECORDS = 5_000
const DEFAULT_RECORD_TTL_MS = 30_000

@Injectable()
export class CanonicalLogService {
  private activeRecords = 0
  private readonly maxActiveRecords: number
  private readonly recordTtlMs: number

  constructor(
    private readonly cls: ClsService,
    @Inject(CANONICAL_LOGGER)
    private readonly logger: ICanonicalLogger,
    @Inject(CANONICAL_LOG_OPTIONS)
    private readonly options: CanonicalLogOptions,
  ) {
    if (!options['service.name'] || options['service.name'].trim() === '') {
      throw new Error(
        'CanonicalLogModule.forRoot: `service.name` is required and must be a non-empty string.',
      )
    }
    this.maxActiveRecords = options.maxActiveRecords ?? DEFAULT_MAX_ACTIVE_RECORDS
    this.recordTtlMs = options.recordTtlMs ?? DEFAULT_RECORD_TTL_MS
  }

  /**
   * Add fields to the current request's canonical record.
   *
   * Call this from any service, guard, or interceptor to contribute
   * domain-specific fields. Use a locally-defined type as the type
   * argument for call-site safety:
   *
   *   type JobFields = { 'job.id'?: string }
   *   canonicalLog.addFields<JobFields>({ 'job.id': job.id })
   *
   * Keys must be namespaced strings (e.g. "job.id", "billing.invoice_id")
   * following OTEL semantic conventions style to avoid collisions.
   * Framework and shared fields are reserved.
   *
   * No-op if this request was shed (store was at capacity when it arrived).
   */
  addFields<T extends object>(fields: T): void {
    // No CLS context — nothing to persist to. Happens for non-HTTP code paths
    // and for exceptions that escape before any middleware runs.
    if (!this.cls.isActive()) return

    // Once a request is marked shed by initialize(), stay shed for the entire
    // request. Prevents a lazy record from being created mid-request with a
    // wrong __startedAt/timestamp if the store drops below cap in the meantime.
    if (this.cls.get(CANONICAL_LOG_SHED_KEY)) return

    // Lazily create the record if it doesn't exist yet. This way addFields()
    // works even if it runs before CanonicalLogMiddleware — e.g. an auth
    // middleware registered in AppModule.configure(), which NestJS mounts
    // before imported modules' middleware.
    let record = this.getRecord()
    if (!record) {
      this.initialize()
      record = this.getRecord()
      if (!record) return // store at capacity — request was shed
    }
    Object.assign(record, fields)
  }

  // ---------------------------------------------------------------------------
  // Internal — used by the lib's own middleware, interceptor, and filter.
  // ---------------------------------------------------------------------------

  /**
   * Called once by CanonicalLogMiddleware at the start of each request.
   *
   * If the CLS store is at capacity (activeRecords >= maxActiveRecords), the
   * request is shed: no record is created, addFields/flush become no-ops.
   * The request itself is completely unaffected, only the canonical line
   * is lost.
   *
   * A TTL timer is attached to the record. If flush() is never called (hung
   * request, crash outside NestJS's filter chain), the timer emits a
   * canonical line with outcome:'timeout' and frees the counter slot.
   */
  initialize(): void {
    // If a record already exists (e.g. addFields() lazily created one before
    // this middleware ran), do nothing.
    if (this.getRecord()) return

    if (this.maxActiveRecords > 0 && this.activeRecords >= this.maxActiveRecords) {
      // Mark shed so later addFields() calls stay no-ops even if the counter
      // drops below cap mid-request.
      if (this.cls.isActive()) {
        this.cls.set(CANONICAL_LOG_SHED_KEY, true)
      }
      return
    }

    this.activeRecords++

    const record: CanonicalRecord = {
      [EMITTED]: false,
      [STARTED_AT]: process.hrtime.bigint(),
      [TTL_TIMER]: undefined,
      timestamp: new Date().toISOString(),
      'service.name': this.options['service.name'],
      ...(this.options['deployment.environment']
        ? { 'deployment.environment': this.options['deployment.environment'] }
        : {}),
    }

    if (this.recordTtlMs > 0) {
      // The timer fires outside the original CLS async context, so we
      // capture `record` directly via closure instead of calling getRecord().
      record[TTL_TIMER] = setTimeout(() => {
        if (record[EMITTED]) return
        record[EMITTED] = true
        this.activeRecords--

        // Emit a partial canonical line so operators still see the request.
        // duration_ms uses the TTL as a lower bound — actual duration unknown.
        record.outcome = 'timeout'
        record.duration_ms =
          Number(process.hrtime.bigint() - record[STARTED_AT]) / 1_000_000
        this.emit(record)
      }, this.recordTtlMs)

      // Don't let the timer keep the Node.js process alive during shutdown.
      record[TTL_TIMER].unref()
    }

    this.cls.set(CANONICAL_LOG_RECORD_KEY, record)
  }

  /**
   * Emit the canonical line exactly once. Subsequent calls for the same
   * request are no-ops — the idempotency flag lives in the record, not in
   * the callers, so interceptor and filter can both call flush() safely.
   * No-op if this request was shed.
   */
  flush(): void {
    const record = this.getRecord()
    if (!record || record[EMITTED]) return

    // Cancel the TTL — request completed normally.
    const timer = record[TTL_TIMER]
    if (timer !== undefined) {
      clearTimeout(timer)
      record[TTL_TIMER] = undefined
    }

    record[EMITTED] = true
    this.activeRecords--
    this.emit(record)
  }

  /** Monotonic clock in ms since the request started. */
  elapsedMs(): number | undefined {
    const record = this.getRecord()
    if (!record) return undefined
    return Number(process.hrtime.bigint() - record[STARTED_AT]) / 1_000_000
  }

  private getRecord(): CanonicalRecord | undefined {
    return this.cls.get<CanonicalRecord>(CANONICAL_LOG_RECORD_KEY)
  }

  /**
   * Write the record to the underlying logger. Symbol-keyed internals
   * (EMITTED, STARTED_AT, TTL_TIMER) are excluded automatically by JSON
   * serialization, so the record is passed through as-is.
   *
   * Observability failures must never affect the request. Wrap in try/catch
   * and swallow — a broken logger should not propagate through flush() into
   * the interceptor or exception filter.
   */
  private emit(record: CanonicalRecord): void {
    try {
      this.logger.info(record, 'canonical')
    } catch {
      // Intentionally swallowed. Alternative: fall back to console.error, but
      // that risks producing more noise from the very failure mode we're
      // trying to isolate.
    }
  }
}
