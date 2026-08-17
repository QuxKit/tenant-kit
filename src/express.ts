// `@quxkit/tenant-kit/express`: resolve + authorize + scope, as Express
// middleware and as a handler wrapper.
//
// Typed against a few fields of Express's request and response — not
// against `@types/express` — so this file has no dependency, runtime or
// type, on Express itself. A real `Request` / `Response` satisfy the
// interfaces structurally; so does a plain object in a test.
//
// Two shapes, because Express has two idioms:
//
//   tenantMiddleware(options)   resolve once, put `req.tenant` there, and run
//                               the rest of the chain inside `tenancy.run` —
//                               the ambient context, and `tenancy.db()`, are
//                               available to every later handler.
//   tenantHandler(options, fn)  resolve, then run `fn` inside `withTenant`:
//                               one transaction, one SET LOCAL, and the
//                               scoped executor handed in as `ctx.db`.
//
// The middleware cannot open a transaction around "the rest of the chain"
// — Express gives it no way to know when the response is done short of
// holding a connection until `finish`, which is a connection budget bug in
// waiting. So the middleware scopes context and the handler scopes a
// transaction; pick per route.

import { resolveForRequest, type TenantHttpOptions } from './framework/http.ts';
import type { ResolvedTenant, SqlExecutor } from './types.ts';

/** The slice of an Express request the helpers read (and `tenant`, which they write). */
export interface ExpressRequestLike {
  hostname?: string;
  path?: string;
  headers: Record<string, string | string[] | undefined>;
  tenant?: ResolvedTenant;
}

/** The slice of an Express response the helpers use to answer a failure. */
export interface ExpressResponseLike {
  status(code: number): { json(body: unknown): unknown };
}

export type ExpressNext = (error?: unknown) => void;

export type ExpressTenantOptions<Req extends ExpressRequestLike = ExpressRequestLike> =
  TenantHttpOptions<Req>;

function toRequestLike(req: ExpressRequestLike) {
  return { hostname: req.hostname, path: req.path, headers: req.headers };
}

/**
 * Resolve the tenant, set `req.tenant`, and continue the chain inside
 * `tenancy.run(resolved, …)`. On failure, answers with the mapped status
 * and body and does not call `next`. Non-tenancy errors go to `next(err)`.
 */
export function tenantMiddleware<Req extends ExpressRequestLike>(
  options: ExpressTenantOptions<Req>,
): (req: Req, res: ExpressResponseLike, next: ExpressNext) => void {
  return (req, res, next) => {
    resolveForRequest(options, req, toRequestLike(req)).then(
      (outcome) => {
        if (!outcome.ok) {
          res.status(outcome.response.status).json(outcome.response.body);
          return;
        }
        req.tenant = outcome.resolved;
        options.tenancy.run(outcome.resolved, () => next());
      },
      (error) => next(error),
    );
  };
}

export interface ExpressTenantContext {
  tenant: ResolvedTenant['tenant'];
  membership: ResolvedTenant['membership'];
  /** The scoped executor for this request's transaction. */
  db: SqlExecutor;
}

/**
 * Resolve, then run `handler` inside `tenancy.withTenant` — one transaction
 * for the handler, committed when it resolves, rolled back when it throws
 * (the error then goes to `next`, i.e. your Express error handler).
 */
export function tenantHandler<Req extends ExpressRequestLike, Res extends ExpressResponseLike>(
  options: ExpressTenantOptions<Req>,
  handler: (req: Req, res: Res, ctx: ExpressTenantContext) => Promise<unknown> | unknown,
): (req: Req, res: Res, next: ExpressNext) => void {
  return (req, res, next) => {
    resolveForRequest(options, req, toRequestLike(req))
      .then(async (outcome) => {
        if (!outcome.ok) {
          res.status(outcome.response.status).json(outcome.response.body);
          return;
        }
        req.tenant = outcome.resolved;
        const { tenant, membership } = outcome.resolved;
        await options.tenancy.withTenant(outcome.resolved, (db) =>
          Promise.resolve(handler(req, res, { tenant, membership, db })),
        );
      })
      .catch((error) => next(error));
  };
}
