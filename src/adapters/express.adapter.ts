import type { CanonicalHttpAdapter } from './http-adapter'

/** Adapter for @nestjs/platform-express (default). */
export class ExpressAdapter implements CanonicalHttpAdapter {
  getRoutePath(req: unknown): string | undefined {
    const r = req as { route?: { path?: string } }
    return r.route?.path
  }

  getRawPath(req: unknown): string | undefined {
    const r = req as { path?: string; url?: string }
    return r.path ?? r.url
  }
}
