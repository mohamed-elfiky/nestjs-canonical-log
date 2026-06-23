/**
 * Adapter interface that abstracts platform-specific request inspection.
 * Implement this to support any HTTP adapter (Express, Fastify, custom).
 */
export interface CanonicalHttpAdapter {
  /**
   * Return the parameterized route template, e.g. /v1/jobs/:id.
   * Called from the interceptor (after routing) and the exception filter
   * (for unmatched routes / guard failures).
   * Return undefined if not resolvable.
   */
  getRoutePath(req: unknown): string | undefined

  /**
   * Return the raw request path without query string, e.g. /v1/jobs/abc123.
   * Used as a fallback when getRoutePath() returns undefined.
   */
  getRawPath(req: unknown): string | undefined
}

// ---------------------------------------------------------------------------
// Built-in adapters
// ---------------------------------------------------------------------------

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
