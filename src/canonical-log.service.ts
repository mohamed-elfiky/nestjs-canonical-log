import { Inject, Injectable } from '@nestjs/common'
import { ClsService } from 'nestjs-cls'
import {
  CANONICAL_LOG_OPTIONS,
  CANONICAL_LOG_RECORD_KEY,
  CANONICAL_LOGGER,
  EMITTED,
  STARTED_AT,
  type CanonicalLogOptions,
  type CanonicalRecord,
  type ICanonicalLogger,
} from './canonical-log.types'

const DEFAULT_RECORD_TTL_MS = 30_000
const DEFAULT_SWEEP_INTERVAL_MS = 5_000
// TTL is the only bound on in-flight record memory, so it can't be disabled.
// Anything below 1s is a misconfiguration.
const MIN_RECORD_TTL_MS = 1_000
const MIN_SWEEP_INTERVAL_MS = 1_000

@Injectable()
export class CanonicalLogService {
  // In-flight records. Gives the sweeper direct references without going
  // through CLS. Bounded by arrival-rate x TTL: flush removes on completion,
  // sweep evicts anything older than recordTtlMs.
  private readonly inFlight = new Set<CanonicalRecord>()
  private sweeper: NodeJS.Timeout | undefined

  private readonly recordTtlMs: number
  private readonly sweepIntervalMs: number

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
    this.recordTtlMs = Math.max(MIN_RECORD_TTL_MS, options.recordTtlMs ?? DEFAULT_RECORD_TTL_MS)
    this.sweepIntervalMs = Math.max(
      MIN_SWEEP_INTERVAL_MS,
      options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS,
    )
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
   */
  addFields<T extends object>(fields: T): void {
    // No CLS context — nothing to persist to. Happens for non-HTTP code paths
    // and for exceptions that escape before any middleware runs.
    if (!this.cls.isActive()) return

    // Lazily create the record if it doesn't exist yet. This way addFields()
    // works even if it runs before CanonicalLogMiddleware — e.g. an auth
    // middleware registered in AppModule.configure(), which NestJS mounts
    // before imported modules' middleware.
    let record = this.getRecord()
    if (!record) {
      this.initialize()
      record = this.getRecord()
      if (!record) return
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
   * A recurring sweep (see sweep()) covers hung requests — if flush() never
   * fires, the sweep emits with outcome:'timeout' and frees the slot.
   */
  initialize(): void {
    // Requires an active CLS context. Without it we'd orphan the record in
    // inFlight (cls.set throws). Middleware always runs inside CLS when
    // ClsModule is mounted; this guard covers manual/misconfigured calls.
    if (!this.cls.isActive()) return

    // If a record already exists (e.g. addFields() lazily created one before
    // this middleware ran), do nothing.
    if (this.getRecord()) return

    const record: CanonicalRecord = {
      [EMITTED]: false,
      [STARTED_AT]: process.hrtime.bigint(),
      timestamp: new Date().toISOString(),
      'service.name': this.options['service.name'],
      stage: 'request_started',
      ...(this.options['deployment.environment']
        ? { 'deployment.environment': this.options['deployment.environment'] }
        : {}),
    }

    this.cls.set(CANONICAL_LOG_RECORD_KEY, record)
    this.inFlight.add(record)

    // Start the sweeper if it's not already running. It self-terminates when
    // the app goes idle, so this is a no-op under sustained load.
    this.ensureSweeper()
  }

  /**
   * Emit the canonical line. Idempotent — interceptor and filter can both
   * call it, only the first one emits.
   */
  flush(): void {
    const record = this.getRecord()
    if (!record || record[EMITTED]) return

    record[EMITTED] = true
    this.inFlight.delete(record)
    this.emit(record)
    // Don't stop the sweeper here — let it self-terminate at the next tick.
    // Under load this avoids churning setInterval/clearInterval per request.
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
   * Start the timeout sweeper if not already running. One recurring timer for
   * the whole app, not one per request. `.unref()` so it doesn't hold the
   * process open on shutdown.
   */
  private ensureSweeper(): void {
    if (this.sweeper) return
    this.sweeper = setInterval(() => this.sweep(), this.sweepIntervalMs)
    this.sweeper.unref()
  }

  /**
   * Emit `outcome: 'timeout'` for any in-flight record older than recordTtlMs
   * and prune it. Self-terminates when inFlight is empty so idle apps don't
   * burn timer cycles.
   */
  private sweep(): void {
    const now = process.hrtime.bigint()
    const ttlNs = BigInt(this.recordTtlMs) * BigInt(1_000_000)

    for (const record of this.inFlight) {
      if (record[EMITTED]) {
        // Should have been removed by flush(); prune defensively.
        this.inFlight.delete(record)
        continue
      }
      if (now - record[STARTED_AT] >= ttlNs) {
        record[EMITTED] = true
        record.outcome = 'timeout'
        record.duration_ms = Number(now - record[STARTED_AT]) / 1_000_000
        this.emit(record)
        this.inFlight.delete(record)
      }
    }

    // Nothing left to watch — stop until initialize() spins us back up.
    if (this.inFlight.size === 0 && this.sweeper) {
      clearInterval(this.sweeper)
      this.sweeper = undefined
    }
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
