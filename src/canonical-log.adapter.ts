/**
 * Adapter interface that abstracts platform-specific (Express, Fastify, etc.)
 * HTTP request inspection. Implement this to support any HTTP adapter.
 *
 * Note: Nest's AbstractHttpAdapter fully wraps the response side
 * (reply, end, setHeader, isHeadersSent, ...) but only exposes three
 * request methods: getRequestHostname, getRequestMethod, getRequestUrl.
 * No parameterized-route accessor, no raw-path helper. The request object stays
 * native (Express's req vs Fastify's req) so users can keep using their 
 * platform's middleware/plugin ecosystem. That leaves the shape differences
 * (req.route.path vs req.routerPath, etc.) for us to handle.
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
