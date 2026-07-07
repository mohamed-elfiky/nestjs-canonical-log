import type { CanonicalHttpAdapter } from './http-adapter'

/** Adapter for @nestjs/platform-fastify. */
export class FastifyAdapter implements CanonicalHttpAdapter {
  getRoutePath(req: unknown): string | undefined {
    // Prefer routeOptions.url (Fastify 4.10+). Only fall back to routerPath
    // on older Fastify where routeOptions doesn't exist — merely reading
    // routerPath on Fastify 4/5 triggers a deprecation warning (FSTDEP017),
    // so we must not touch it when routeOptions is available.
    const r = req as { routerPath?: string; routeOptions?: { url?: string } }
    if (r.routeOptions !== undefined) return r.routeOptions.url
    return r.routerPath
  }

  getRawPath(req: unknown): string | undefined {
    const r = req as { url?: string }
    // Fastify's req.url includes the query string — strip it.
    return r.url?.split('?')[0]
  }
}
