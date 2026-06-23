import { Inject, Injectable } from '@nestjs/common'
import { ClsService } from 'nestjs-cls'
import {
  CANONICAL_LOG_BAG_KEY,
  CANONICAL_LOG_OPTIONS,
  CANONICAL_LOGGER,
  type CanonicalBag,
  type CanonicalLogOptions,
  type ICanonicalLogger,
} from './canonical-log.types'

const DEFAULT_MAX_ACTIVE_BAGS = 5_000
const DEFAULT_BAG_TTL_MS = 30_000

@Injectable()
export class CanonicalLogService {
  // Singleton counter — tracks how many requests currently have an active bag.
  // Safe without locks: Node.js event loop is single-threaded; increment
  // (initialize) and decrement (drain / TTL expiry) are both synchronous.
  private activeBags = 0
  private readonly maxActiveBags: number
  private readonly bagTtlMs: number

  constructor(
    private readonly cls: ClsService,
    @Inject(CANONICAL_LOGGER)
    private readonly logger: ICanonicalLogger,
    @Inject(CANONICAL_LOG_OPTIONS)
    private readonly options: CanonicalLogOptions,
  ) {
    this.maxActiveBags = options.maxActiveBags ?? DEFAULT_MAX_ACTIVE_BAGS
    this.bagTtlMs = options.bagTtlMs ?? DEFAULT_BAG_TTL_MS
  }

  /**
   * Merge arbitrary fields into the current request's canonical bag.
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
   * Framework and kernel fields are reserved.
   *
   * No-op if this request was shed (store was at capacity when it arrived).
   */
  addFields<T extends object>(fields: T): void {
    // No CLS context = nothing we can persist to. Silently drop the fields
    // rather than crash — this happens for non-HTTP code paths and for
    // exceptions that escape before any middleware runs.
    if (!this.cls.isActive()) return

    // Lazily create the bag if it doesn't exist yet. This makes addFields()
    // tolerant of middleware ordering: a caller that runs before
    // CanonicalLogMiddleware (e.g. an auth middleware registered in
    // AppModule.configure(), which NestJS mounts before imported modules'
    // middleware) still contributes fields to the canonical line.
    let bag = this.getBag()
    if (!bag) {
      this.initialize()
      bag = this.getBag()
      if (!bag) return // store at capacity — request was shed
    }
    Object.assign(bag, fields)
  }

  // ---------------------------------------------------------------------------
  // Internal — used by the lib's own middleware, interceptor, and filter.
  // ---------------------------------------------------------------------------

  /**
   * Called once by CanonicalLogMiddleware at the start of each request.
   *
   * If the CLS store is at capacity (activeBags >= maxActiveBags), the
   * request is shed: no bag is created, addFields/drain become no-ops.
   * The request itself is completely unaffected — only the canonical line
   * is lost.
   *
   * A TTL timer is armed on the bag. If drain() is never called (hung
   * request, crash outside NestJS's filter chain), the timer evicts the
   * bag and decrements the counter so the store doesn't leak.
   */
  initialize(): void {
    // Idempotent: if a bag already exists in CLS (e.g. addFields() lazily
    // created one because it was called before this middleware ran), do
    // nothing. This keeps middleware ordering flexible without leaking
    // counter slots or duplicating timers.
    if (this.getBag()) return

    if (this.maxActiveBags > 0 && this.activeBags >= this.maxActiveBags) {
      return
    }

    this.activeBags++

    const bag: CanonicalBag = {
      __emitted: false,
      __startedAt: process.hrtime.bigint(),
      __ttlTimer: undefined,
      timestamp: new Date().toISOString(),
      'service.name': this.options.service,
      ...(this.options.env
        ? { 'deployment.environment': this.options.env }
        : {}),
    }

    if (this.bagTtlMs > 0) {
      // The timer fires outside the original CLS async context, so we
      // capture `bag` directly via closure instead of calling getBag().
      bag.__ttlTimer = setTimeout(() => {
        if (!bag.__emitted) {
          bag.__emitted = true
          this.activeBags--
        }
      }, this.bagTtlMs)

      // Don't let the timer keep the Node.js process alive during shutdown.
      bag.__ttlTimer.unref()
    }

    this.cls.set(CANONICAL_LOG_BAG_KEY, bag)
  }

  /**
   * Emit the canonical line exactly once. Subsequent calls for the same
   * request are no-ops — the idempotency flag lives in the bag, not in
   * the callers, so interceptor and filter can both call drain() safely.
   * No-op if this request was shed.
   */
  drain(): void {
    const bag = this.getBag()
    if (!bag || bag.__emitted) return

    // Cancel the TTL — request completed normally.
    if (bag.__ttlTimer !== undefined) {
      clearTimeout(bag.__ttlTimer)
      bag.__ttlTimer = undefined
    }

    bag.__emitted = true
    this.activeBags--

    const { __emitted: _e, __startedAt: _s, __ttlTimer: _t, ...logFields } = bag
    this.logger.info(logFields, 'canonical')
  }

  /** Nanosecond-precision wall-clock ms since initialize(). */
  elapsedMs(): number | undefined {
    const bag = this.getBag()
    if (!bag?.__startedAt) return undefined
    return Number(process.hrtime.bigint() - bag.__startedAt) / 1_000_000
  }

  private getBag(): CanonicalBag | undefined {
    return this.cls.get<CanonicalBag>(CANONICAL_LOG_BAG_KEY)
  }
}
