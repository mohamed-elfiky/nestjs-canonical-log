import { Injectable, NestMiddleware } from '@nestjs/common'
import type { NextFunction, Request, Response } from 'express'
import { CanonicalLogService } from 'nestjs-canonical-log'

// Simulated auth — in a real app this decodes a JWT/session and resolves the principal.
// Field shape is whatever fits your app: actor_id for a generic principal,
// user_id for B2C, tenant_id + actor_id for multi-tenant, customer_id for SaaS.
// There is no required schema.
@Injectable()
export class AuthMiddleware implements NestMiddleware {
  constructor(private readonly canonicalLog: CanonicalLogService) {}

  use(_req: Request, _res: Response, next: NextFunction): void {
    this.canonicalLog.addFields({ actor_id: 'user-42' })
    next()
  }
}
