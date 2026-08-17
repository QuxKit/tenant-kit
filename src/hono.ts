// `@quxkit/tenant-kit/hono`: resolve + authorize + scope, as Hono middleware.
//
// Hono's middleware awaits `next()`, which is exactly the shape `withTenant`
// wants: the downstream handler runs inside the callback, so one transaction
// with one SET LOCAL covers the whole handler and commits when it returns.
// The resolved tenant and the scoped executor are set on the context under
// `tenant` and `tenantDb`.
//
// Typed against a few members of Hono's `Context` — `req.header`,
// `req.url`, `set`, `json` — not against `hono` itself. No runtime or type
// dependency; a real context satisfies it structurally, so does a fake.

import { resolveForRequest, type TenantHttpOptions } from './framework/http.ts';
import type { ResolvedTenant, SqlExecutor } from './types.ts';

/** The slice of a Hono context the middleware uses. */
export interface HonoContextLike {
  req: {
    url: string;
    header(name: string): string | undefined;
    header(): Record<string, string>;
  };
  set(key: string, value: unknown): void;
  json(body: unknown, status?: number): unknown;
}

export type HonoNext = () => Promise<void>;

export type HonoTenantOptions<C extends HonoContextLike = HonoContextLike> = TenantHttpOptions<C>;

/** What the middleware sets: `c.get('tenant')` and `c.get('tenantDb')`. */
export interface HonoTenantVariables {
  tenant: ResolvedTenant;
  tenantDb: SqlExecutor;
}

/**
 * Resolve, set `tenant` and `tenantDb`, and run downstream inside
 * `withTenant`. On failure, returns the mapped JSON response and downstream
 * never runs. Non-tenancy errors propagate to Hono's `onError`.
 */
export function tenantMiddleware<C extends HonoContextLike>(
  options: HonoTenantOptions<C>,
): (c: C, next: HonoNext) => Promise<unknown> {
  return async (c, next) => {
    const url = new URL(c.req.url);
    const outcome = await resolveForRequest(options, c, {
      hostname: url.hostname,
      path: url.pathname,
      headers: c.req.header(),
    });
    if (!outcome.ok) return c.json(outcome.response.body, outcome.response.status);
    c.set('tenant', outcome.resolved);
    await options.tenancy.withTenant(outcome.resolved, async (db) => {
      c.set('tenantDb', db);
      await next();
    });
  };
}
