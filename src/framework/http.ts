// The framework-neutral half of the framework helpers: what every adapter
// does before it touches a framework object.
//
// Each of `./express`, `./hono`, `./next` is a few lines over this file:
// build a `RequestLike`, call `resolveForRequest`, and either run the
// handler inside `withTenant` or answer with the failure it returned. The
// point of sharing this is the error mapping. Written per app, it drifts —
// one app answers `not_a_member` with 403 and leaks tenant existence to
// anyone with a slug list. Here it is decided once, and overridable once.

import { TenancyError } from '../errors.ts';
import type { Tenancy } from '../instance.ts';
import { requireRole } from '../members.ts';
import { requirePermission } from '../roles.ts';
import type { BuiltinRole, Extractor, RequestLike, ResolvedTenant, UserId } from '../types.ts';

/** What every helper takes. `Req` is the framework's own request type. */
export interface TenantHttpOptions<Req> {
  tenancy: Tenancy;
  extract: Extractor;
  /**
   * The authenticated user id for this request — from your auth layer's
   * session, token or middleware. `null` means unauthenticated and answers
   * 401 before any tenant lookup. Never read this from the request body.
   */
  userId: (req: Req) => UserId | null | undefined | Promise<UserId | null | undefined>;
  /** Refuse below this built-in role (403 `forbidden`). */
  requireRole?: BuiltinRole;
  /** Refuse without this permission (403 `permission_denied`). */
  requirePermission?: string;
  /**
   * Turn a resolution failure into a status and body. The default is
   * `defaultFailureResponse`; replace it to change what your API reveals.
   */
  onFailure?: (failure: HttpFailure) => HttpFailureResponse;
}

/** Why a request did not get a tenant. */
export type HttpFailure = { kind: 'unauthenticated' } | { kind: 'tenancy'; error: TenancyError };

export interface HttpFailureResponse {
  status: number;
  body: { error: string; code?: string };
}

/**
 * The default answers, chosen for enumeration resistance: whether a tenant
 * exists is information, so `unknown_tenant`, `not_a_member` and
 * `tenant_archived` all answer 404. Your logs still see the distinct code.
 */
export function defaultFailureResponse(failure: HttpFailure): HttpFailureResponse {
  if (failure.kind === 'unauthenticated')
    return { status: 401, body: { error: 'authentication required' } };
  const { code } = failure.error;
  switch (code) {
    case 'no_tenant_claim':
      return { status: 400, body: { error: 'no tenant in request', code } };
    case 'unknown_tenant':
    case 'not_a_member':
    case 'tenant_archived':
      return { status: 404, body: { error: 'not found', code: 'unknown_tenant' } };
    case 'forbidden':
    case 'permission_denied':
      return { status: 403, body: { error: 'forbidden', code } };
    default:
      return { status: 500, body: { error: 'tenant resolution failed', code } };
  }
}

export type ResolveOutcome =
  | { ok: true; resolved: ResolvedTenant }
  | { ok: false; response: HttpFailureResponse; failure: HttpFailure };

/**
 * userId → resolve → role/permission checks, with every failure turned into
 * a response by `onFailure`. Errors that are not `TenancyError`s (a database
 * down, a bug in `userId`) are rethrown: those are 500s the framework's own
 * error handling should see, not tenancy failures to be dressed up.
 */
export async function resolveForRequest<Req>(
  options: TenantHttpOptions<Req>,
  req: Req,
  like: RequestLike,
): Promise<ResolveOutcome> {
  const onFailure = options.onFailure ?? defaultFailureResponse;
  const userId = await options.userId(req);
  if (userId === null || userId === undefined || userId.length === 0) {
    const failure: HttpFailure = { kind: 'unauthenticated' };
    return { ok: false, response: onFailure(failure), failure };
  }
  try {
    const resolved = await options.tenancy.resolve(like, { userId, extract: options.extract });
    if (options.requireRole !== undefined) requireRole(resolved.membership, options.requireRole);
    if (options.requirePermission !== undefined)
      await requirePermission(
        options.tenancy.unscopedDb(),
        resolved.tenant.id,
        userId,
        options.requirePermission,
      );
    return { ok: true, resolved };
  } catch (error) {
    if (!TenancyError.is(error)) throw error;
    const failure: HttpFailure = { kind: 'tenancy', error };
    return { ok: false, response: onFailure(failure), failure };
  }
}

/** Header bag → the `RequestLike.headers` shape (already compatible; typed for clarity). */
export type HeaderBag = Record<string, string | string[] | undefined>;

/** Fetch-API `Headers` → a header bag. */
export function headersToBag(headers: {
  forEach(cb: (value: string, key: string) => void): void;
}): HeaderBag {
  const bag: HeaderBag = {};
  headers.forEach((value, key) => {
    bag[key] = value;
  });
  return bag;
}
