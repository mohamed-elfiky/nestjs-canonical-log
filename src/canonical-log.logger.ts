import { PinoLogger } from 'nestjs-pino'
import type { ICanonicalLogger } from './canonical-log.types'

/**
 * Default ICanonicalLogger, backed by nestjs-pino.
 * Swap for a different sink by implementing ICanonicalLogger and passing it
 * via forRoot({ logger: myLogger }).
 */
export class PinoCanonicalLogger implements ICanonicalLogger {
  constructor(private readonly pino: PinoLogger) {}

  info(fields: Record<string, unknown>, message: string): void {
    this.pino.info(fields, message)
  }
}
