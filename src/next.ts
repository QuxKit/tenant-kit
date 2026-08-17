// `@quxkit/tenant-kit/next`: resolve + authorize + scope, for Next.js App
// Router route handlers (and anything else that speaks fetch `Request` /
// `Response` — Remix loaders, Bun, Deno, Cloudflare Workers with a Node
// database driver).
//
// No dependency on `next`: `NextRequest` *is* a `Request`, and a `Response`
// is what a route handler returns. The wrapper resolves from the request's
// URL and headers, runs your handler inside `withTenant`, and turns a
// failure into a JSON `Response` with the mapped status.

import { headersToBag, resolveForRequest, type TenantHttpOptions } from './framework/http.ts';
import type { ResolvedTenant, SqlExecutor } from './types.ts';

/** The slice of a fetch `Request` the wrapper reads. `Request` and `NextRequest` satisfy it. */
export interface FetchRequestLike {
  url: string;
  headers: {
    get(name: string): string | null;
    forEach(cb: (value: string, key: string) => void): void;
  };
}

export type NextTenantOptions<Req extends FetchRequestLike = FetchRequestLike> =
  TenantHttpOptions<Req>;

export interface NextTenantContext {
  tenant: ResolvedTenant['tenant'];
  membership: ResolvedTenant['membership'];
  /** The scoped executor for this handler's transaction. */
  db: SqlExecutor;
}

/**
 * Wrap a route handler. `RouteCtx` is whatever Next passes second (`{ params }`);
 * it is forwarded untouched. The handler runs inside `withTenant`: one
 * transaction, committed when the handler returns its `Response`, rolled
 * back if it throws (the error propagates to Next).
 */
export function withTenant<Req extends FetchRequestLike, RouteCtx = unknown>(
  options: NextTenantOptions<Req>,
  handler: (req: Req, ctx: NextTenantContext, route: RouteCtx) => Promise<Response> | Response,
): (req: Req, route: RouteCtx) => Promise<Response> {
  return async (req, route) => {
    const url = new URL(req.url);
    const outcome = await resolveForRequest(options, req, {
      hostname: url.hostname,
      path: url.pathname,
      headers: headersToBag(req.headers),
    });
    if (!outcome.ok)
      return Response.json(outcome.response.body, { status: outcome.response.status });
    const { tenant, membership } = outcome.resolved;
    return options.tenancy.withTenant(outcome.resolved, (db) =>
      Promise.resolve(handler(req, { tenant, membership, db }, route)),
    );
  };
}
