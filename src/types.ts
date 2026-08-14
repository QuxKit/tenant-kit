// The shared vocabulary: what a tenant is, who belongs to it, and the shapes
// that cross the library's boundary.
//
// Everything here is a type or an interface. No runtime code, on purpose, so
// every other module can depend on this one without any of them depending on
// each other.
//
// One rule governs this file: tenant-kit defines the tenant and *consumes* the
// user. There is no users table anywhere in this library and no branch that
// inspects how a `UserId` was authenticated. Authentication is the host app's
// (or its auth provider's) job; the moment this library grows a password
// column it has become an auth product with a tenancy feature, which is the
// scope creep this comment exists to block.

// --- database ---------------------------------------------------------------

/**
 * The whole database dependency.
 *
 * Structurally identical to billing-kit's `SqlExecutor`, and deliberately so:
 * the two libraries are siblings, and an adapter written once over `pg.Pool`
 * (about ten lines — see `test/pg-executor.ts` for the proof) satisfies both.
 * An app running both kits carries one pool, not two.
 *
 * `query` returns rows as the driver produces them. `transaction` must pin
 * `fn` to a single connection; an implementation that hands back the pool
 * would run the body's statements on different connections, and — this matters
 * more here than anywhere — `SET LOCAL` would scope the tenant onto one
 * connection while the queries run unscoped on another. Isolation that
 * depends on the transaction being real is why this comment is a contract.
 */
export interface SqlExecutor {
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]>;
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

/** Injected so tests do not depend on wall clock drift. */
export type Clock = () => Date;

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

// --- identity ---------------------------------------------------------------

/**
 * The tenant boundary. Text, not a branded type, because this is the exact
 * alias billing-kit declares — the two must remain assignable to each other
 * without a cast, since a resolved tenant here becomes the `tenantId` on every
 * usage event there.
 *
 * What keeps it safe is not the type but the flow: the only functions that
 * *produce* a `TenantId` are the store reads in tenants.ts, and the only way
 * from an HTTP request to one of those reads is `resolve()`, which checks
 * membership on the way through. An extractor's output is a `TenantClaim` —
 * a different shape — precisely so that untrusted request data cannot be
 * passed where a verified id is expected.
 */
export type TenantId = string;

/**
 * Whoever the host app's auth layer says is calling. Opaque here: a Clerk user
 * id, an Auth0 sub, a session's own primary key — tenant-kit never looks
 * inside it and never verifies it. Handing this library an unauthenticated
 * string is the one mistake it cannot catch for you, and every doc that
 * mentions `UserId` says so.
 */
export type UserId = string;

// --- tenants ----------------------------------------------------------------

export type TenantState = 'active' | 'archived';

export interface Tenant {
  id: TenantId;
  /**
   * The human-facing handle: the subdomain, the path segment, the thing in the
   * URL. Lowercase DNS-label rules (see `validateSlug`), because the moment a
   * slug appears in a hostname every character that DNS forbids becomes a
   * routing bug.
   */
  slug: string;
  name: string;
  state: TenantState;
  createdAt: Date;
  archivedAt: Date | null;
}

export interface CreateTenantInput {
  slug: string;
  name: string;
  /** Supplied for migrations importing existing ids; generated otherwise. */
  id?: TenantId;
}

// --- membership -------------------------------------------------------------

/**
 * Three roles, fixed. `owner` administers membership itself, `admin`
 * administers the tenant, `member` uses it. Deliberately not a general RBAC
 * engine: permissions-on-resources is an application vocabulary, and every
 * tenancy library that tried to own it became a policy language nobody
 * adopted whole. The host app builds its permissions *on top of* these three,
 * and `atLeast` is the only comparison this library will ever do.
 */
export type Role = 'owner' | 'admin' | 'member';

export interface Membership {
  tenantId: TenantId;
  userId: UserId;
  role: Role;
  createdAt: Date;
}

export interface AddMemberInput {
  tenantId: TenantId;
  userId: UserId;
  role: Role;
}

// --- resolution -------------------------------------------------------------

/**
 * The subset of an incoming request that resolution reads. Framework-neutral
 * on purpose — Express, Fastify, Hono and `node:http` can all produce this in
 * a line or two, and taking a framework's request type would make that
 * framework a dependency of a library whose whole pitch is embedding into
 * whatever you already run.
 */
export interface RequestLike {
  /** Host name, with or without port; extractors strip the port. */
  hostname?: string;
  /** Path component, leading slash included. */
  path?: string;
  /** Header names are matched case-insensitively. */
  headers?: Record<string, string | string[] | undefined>;
  /**
   * Claims from a token *your auth layer has already verified*. Extractors
   * read them; nothing here checks a signature. Unverified claims passed in
   * this field are an authentication bypass, and it is the caller's.
   */
  claims?: Record<string, unknown>;
}

/**
 * What an extractor found: a *claimed* tenant reference, not a tenant.
 *
 * This shape is the type-level wall between the two halves of resolution.
 * Extraction reads the request and produces a claim; authorization looks the
 * claim up and checks the caller's membership. A claim never becomes a
 * `Tenant` except by passing through `resolve()`, so "trust the subdomain"
 * is not something this API can express by accident.
 */
export interface TenantClaim {
  /** Exactly one of these is set, depending on what the strategy reads. */
  slug?: string;
  tenantId?: TenantId;
  /** Which strategy produced it — for logs and for the error when it fails. */
  via: string;
}

/**
 * Reads a request, returns a claim or null. Pure: no I/O, no store access,
 * so strategies compose with `firstOf` and test without a database.
 */
export type Extractor = (req: RequestLike) => TenantClaim | null;

/** The output of `resolve()`: the tenant, and the caller's standing in it. */
export interface ResolvedTenant {
  tenant: Tenant;
  membership: Membership;
}

// --- context ----------------------------------------------------------------

/**
 * What `run` puts in AsyncLocalStorage and `current`/`require` read back.
 * `tenant` and `membership` are optional because background work (a queue
 * consumer, a sweep) legitimately enters a tenant scope holding only the id.
 */
export interface TenantContext {
  tenantId: TenantId;
  tenant?: Tenant;
  membership?: Membership;
}
