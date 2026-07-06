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
   * Add fields to the current request's canonical record. Pass a local type
   * for call-site safety:
   *
   *   type JobFields = { 'job.id'?: string }
   *   canonicalLog.addFields<JobFields>({ 'job.id': job.id })
   *
   * Use namespaced keys (e.g. "job.id", "billing.invoice_id") to avoid
   * collisions. Framework and shared fields are reserved.
   * No-op if the request was shed.
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

  /**
   * Set the current stage of the request. The value at flush time tells the
   * reader where the request was when it stopped.
   *
   * Enforce a stage enum at compile time using a local union type:
   *
   *   type JobStage = 'fetching_job' | 'writing_status' | 'notifying' | 'done'
   *   canonicalLog.stage<JobStage>('fetching_job')
   *
   * Keep the set of values small per handler so `stage` stays queryable as
   * a dimension.
   */
  stage<T extends string>(name: T): void {
    this.addFields({ stage: name })
  }

  // ---------------------------------------------------------------------------
  // Internal — used by the lib's own middleware, interceptor, and filter.
  // ---------------------------------------------------------------------------

  /**
   * Starts a new record for the current request. Called once by the middleware.
   * If we're at capacity, the request is shed (no record, no canonical line);
   * the request itself still runs normally. A TTL timer covers hung requests
   * — if flush() never fires, it emits with outcome:'timeout' and frees the slot.
   */
  initialize(): void {
    // If a record already exists (e.g. addFields() lazily created one before
    // this middleware ran), do nothing.
    if (this.getRecord()) return

    if (this.maxActiveRecords > 0 && this.activeRecords >= this.maxActiveRecords) {
      // Mark shed so addFields() stays a no-op for this request even if the
      // counter drops below cap later.
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
      // stage is always present. Callers override as work progresses via
      // svc.stage(name). If they never do, "request_started" is the terminal
      // value — self-describing: "the request never reached a tracked stage".
      stage: 'request_started',
      ...(this.options['deployment.environment']
        ? { 'deployment.environment': this.options['deployment.environment'] }
        : {}),
    }

    if (this.recordTtlMs > 0) {
      // Timer fires outside CLS — capture `record` via closure.
      record[TTL_TIMER] = setTimeout(() => {
        if (record[EMITTED]) return
        record[EMITTED] = true
        this.activeRecords--

        // Emit with what we have so hung requests stay visible.
        record.outcome = 'timeout'
        record.duration_ms = Number(process.hrtime.bigint() - record[STARTED_AT]) / 1_000_000
        this.emit(record)
      }, this.recordTtlMs)

      // Don't hold the process open on shutdown.
      record[TTL_TIMER].unref()
    }

    this.cls.set(CANONICAL_LOG_RECORD_KEY, record)
  }

  /**
   * Emit the canonical line. Idempotent — interceptor and filter can both
   * call it, only the first one emits. No-op if the request was shed.
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
   * Write the record to the logger. Symbol-keyed internals drop out via JSON
   * serialization, so we pass the record as-is. Errors are swallowed —
   * observability failures must not break the request.
   */
  private emit(record: CanonicalRecord): void {
    try {
      this.logger.info(record, 'canonical')
    } catch {
      // Silent by design — falling back to console.error would only amplify
      // the failure mode we're isolating.
    }
  }
}
