import type { CanonicalHttpAdapter } from './http-adapter'

/** Adapter for @nestjs/platform-fastify. */
export class FastifyAdapter implements CanonicalHttpAdapter {
  getRoutePath(req: unknown): string | undefined {
    const r = req as { routerPath?: string; routeOptions?: { url?: string } }
    return r.routerPath ?? r.routeOptions?.url
  }

  getRawPath(req: unknown): string | undefined {
    const r = req as { url?: string }
    // Fastify's req.url includes the query string — strip it.
    return r.url?.split('?')[0]
  }
}
