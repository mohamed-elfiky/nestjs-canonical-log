import { PinoLogger } from 'nestjs-pino'
import type { ICanonicalLogger } from './canonical-log.types'

/**
 * Default ICanonicalLogger implementation backed by nestjs-pino.
 *
 * This is the mapper between the canonical record and the pino logger.
 * It lives here — not in the module factory — so that:
 *  - The factory stays pure wiring (no logic).
 *  - Future transformations (field redaction, truncation, key normalization)
 *    have a clear home without touching the service or the module.
 *
 * To use a different logger (Winston, console, custom sink), implement
 * ICanonicalLogger and pass it via forRoot({ logger: myLogger }).
 */
export class PinoCanonicalLogger implements ICanonicalLogger {
  constructor(private readonly pino: PinoLogger) {}

  info(fields: Record<string, unknown>, message: string): void {
    this.pino.info(fields, message)
  }
}
