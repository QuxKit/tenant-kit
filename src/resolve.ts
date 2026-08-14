// Request → tenant, in two halves that must not be confused.
//
// **Extraction** reads the request and produces a `TenantClaim` — the string
// the caller *says* names their tenant. Pure functions, no store access.
//
// **Authorization** (`resolve`, at the bottom) looks the claim up and checks
// the caller's membership. Only it produces a `ResolvedTenant`.
//
// The split is the security design. Every multi-tenant breach writeup has the
// same shape: some layer treated a request-supplied tenant reference as
// authenticated. Here the type system separates the two — an extractor cannot
// return a `Tenant`, and nothing downstream accepts a `TenantClaim` — so the
// unsafe shortcut is not expressible without going around the library.
//
// A note on `fromHeader`: a tenant header is only meaningful if something you
// control *sets* it — an API gateway, a reverse proxy that already terminated
// auth. Straight from the internet it is attacker input, which is fine (it is
// a claim, and membership still gates it) but useless as routing truth. The
// docstring says so because someone will copy the example without the proxy.

import { TenancyError } from './errors.ts';
import { getMembership } from './members.ts';
import { getTenant, getTenantBySlug } from './tenants.ts';
import type {
  Extractor,
  RequestLike,
  ResolvedTenant,
  SqlExecutor,
  TenantClaim,
  UserId,
} from './types.ts';

// --- extractors -------------------------------------------------------------

function hostOf(req: RequestLike): string | null {
  const raw = req.hostname ?? headerOf(req, 'host');
  if (raw === null || raw === undefined) return null;
  // Strip a port if present. IPv6 literals ([::1]:3000) never carry a tenant
  // subdomain, so losing them to the bracket check is fine.
  const host = raw.startsWith('[') ? raw : raw.split(':')[0];
  return host.toLowerCase();
}

function headerOf(req: RequestLike, name: string): string | null {
  if (req.headers === undefined) return null;
  const want = name.toLowerCase();
  for (const [key, value] of Object.entries(req.headers)) {
    if (key.toLowerCase() !== want) continue;
    const first = Array.isArray(value) ? value[0] : value;
    return first === undefined || first.length === 0 ? null : first;
  }
  return null;
}

/**
 * `acme.example.com` → slug `acme`.
 *
 * Exactly one label below the base domain, or no claim: `example.com` itself
 * is the marketing site, and `a.b.example.com` is ambiguous — guessing which
 * label is the tenant turns a URL typo into someone else's login page.
 */
export function fromSubdomain(options: { baseDomain: string }): Extractor {
  const base = options.baseDomain.toLowerCase().replace(/^\.+/, '');
  return (req) => {
    const host = hostOf(req);
    if (host === null || host === base || !host.endsWith(`.${base}`)) return null;
    const label = host.slice(0, -(base.length + 1));
    if (label.length === 0 || label.includes('.')) return null;
    return { slug: label, via: `subdomain of ${base}` };
  };
}

/**
 * Read the slug from a header, `x-tenant` by default. For requests that have
 * passed through a gateway you control; see the module comment before using
 * it on a public edge.
 */
export function fromHeader(name = 'x-tenant'): Extractor {
  return (req) => {
    const value = headerOf(req, name);
    return value === null ? null : { slug: value, via: `header ${name}` };
  };
}

/** `/t/acme/…` → slug `acme`. The prefix is configurable; the default is `/t/`. */
export function fromPath(prefix = '/t/'): Extractor {
  return (req) => {
    if (req.path === undefined || !req.path.startsWith(prefix)) return null;
    const rest = req.path.slice(prefix.length);
    const slug = rest.split('/')[0];
    return slug.length === 0 ? null : { slug, via: `path prefix ${prefix}` };
  };
}

/**
 * Read a tenant *id* from a verified token's claims — the shape for
 * service-to-service calls, where the token was minted for one tenant and
 * carries it. `req.claims` must come from a token your auth layer verified;
 * this function trusts the field because there is nothing else it could do.
 */
export function fromClaim(claim = 'tenant_id'): Extractor {
  return (req) => {
    const value = req.claims?.[claim];
    return typeof value === 'string' && value.length > 0
      ? { tenantId: value, via: `claim ${claim}` }
      : null;
  };
}

/** First extractor to produce a claim wins. Order is precedence. */
export function firstOf(...extractors: Extractor[]): Extractor {
  return (req) => {
    for (const extract of extractors) {
      const claim = extract(req);
      if (claim !== null) return claim;
    }
    return null;
  };
}

// --- authorization ----------------------------------------------------------

/**
 * Turn a claim into a tenant the caller is actually a member of.
 *
 * Order of checks, and why: existence, then state, then membership. Archived
 * beats not-a-member so an ex-tenant's own users see "archived" rather than
 * being told they never belonged. What your HTTP layer *reveals* of these
 * distinctions is its own decision — see errors.ts on collapsing 403 into 404
 * for enumeration resistance.
 */
export async function authorize(
  db: SqlExecutor,
  claim: TenantClaim,
  userId: UserId,
): Promise<ResolvedTenant> {
  const tenant =
    claim.tenantId !== undefined
      ? await getTenant(db, claim.tenantId)
      : claim.slug !== undefined
        ? await getTenantBySlug(db, claim.slug)
        : (() => {
            throw new TenancyError({ code: 'no_tenant_claim' });
          })();
  if (tenant.state !== 'active')
    throw new TenancyError({ code: 'tenant_archived', tenantId: tenant.id });
  const membership = await getMembership(db, tenant.id, userId);
  return { tenant, membership };
}

/** Extraction and authorization in one call — the request-handler entry point. */
export async function resolve(
  db: SqlExecutor,
  req: RequestLike,
  options: { userId: UserId; extract: Extractor },
): Promise<ResolvedTenant> {
  const claim = options.extract(req);
  if (claim === null) throw new TenancyError({ code: 'no_tenant_claim' });
  return authorize(db, claim, options.userId);
}
