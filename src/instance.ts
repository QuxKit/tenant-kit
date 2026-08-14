// The executor and the clock, bound once — billing-kit's factory shape,
// applied here.
//
// Every core function takes `(db, …, now)`; that is right for the functions
// and wrong for a call site, which would repeat the wiring on every line and
// inline `new Date()` at exactly the place a Clock exists to remove. So:
//
//   const tenancy = createTenancy({ db });
//   const resolved = await tenancy.resolve(req, { userId, extract });
//   await tenancy.run(resolved, () => handler(tenancy.db()));
//
// A factory, not a singleton. The instance also owns the `TenantScope` —
// the AsyncLocalStorage lives here rather than at module level so that two
// instances in one process (a test on a rolled-back executor, a worker per
// shard) cannot see each other's ambient tenant.
//
// The free functions stay exported from their modules. This is sugar over
// them, not a replacement.

import { TenantScope } from './context.ts';
import { scopedExecutor } from './isolation.ts';
import {
  addMember,
  getMembership,
  listMembers,
  removeMember,
  setRole,
  tenantsOf,
} from './members.ts';
import { authorize, resolve } from './resolve.ts';
import {
  archiveTenant,
  createTenant,
  getTenant,
  getTenantBySlug,
  listTenants,
  renameTenant,
  restoreTenant,
} from './tenants.ts';
import type {
  AddMemberInput,
  Clock,
  CreateTenantInput,
  Extractor,
  Logger,
  Membership,
  RequestLike,
  ResolvedTenant,
  Role,
  SqlExecutor,
  Tenant,
  TenantClaim,
  TenantContext,
  TenantId,
  UserId,
} from './types.ts';

export interface TenancyOptions {
  db: SqlExecutor;
  /** Defaults to the system clock. Supplied by tests. */
  clock?: Clock;
  logger?: Logger;
  /** Overrides `RESERVED_SLUGS` for deployments with their own reserved surface. */
  reservedSlugs?: ReadonlySet<string>;
}

export interface Tenancy {
  // tenants
  createTenant(input: CreateTenantInput): Promise<Tenant>;
  getTenant(id: TenantId): Promise<Tenant>;
  getTenantBySlug(slug: string): Promise<Tenant>;
  listTenants(query?: { state?: Tenant['state'] }): Promise<Tenant[]>;
  renameTenant(id: TenantId, name: string): Promise<Tenant>;
  archiveTenant(id: TenantId): Promise<Tenant>;
  restoreTenant(id: TenantId): Promise<Tenant>;

  // membership
  addMember(input: AddMemberInput): Promise<Membership>;
  getMembership(tenantId: TenantId, userId: UserId): Promise<Membership>;
  listMembers(tenantId: TenantId): Promise<Membership[]>;
  tenantsOf(userId: UserId): Promise<Array<{ tenant: Tenant; membership: Membership }>>;
  setRole(tenantId: TenantId, userId: UserId, role: Role): Promise<Membership>;
  removeMember(tenantId: TenantId, userId: UserId): Promise<void>;

  // resolution
  resolve(req: RequestLike, options: { userId: UserId; extract: Extractor }): Promise<ResolvedTenant>;
  authorize(claim: TenantClaim, userId: UserId): Promise<ResolvedTenant>;

  // context
  run<T>(scope: ResolvedTenant | TenantId, fn: () => T): T;
  current(): TenantContext | null;
  require(): TenantContext;

  /**
   * An RLS-scoped executor for the given tenant — or, with no argument, for
   * the ambient one, throwing `no_tenant_context` outside `run`. This is the
   * executor to hand to application queries, and to billing-kit.
   */
  db(tenantId?: TenantId): SqlExecutor;

  /** The unscoped executor this instance was built on. Named so that reaching
   *  for it reads as the deliberate act it should be: administrative queries,
   *  cross-tenant reports, the resolve path itself. */
  unscopedDb(): SqlExecutor;
}

export function createTenancy(options: TenancyOptions): Tenancy {
  const { db, reservedSlugs } = options;
  const clock: Clock = options.clock ?? (() => new Date());
  const scope = new TenantScope();

  return {
    createTenant: (input) => createTenant(db, input, clock(), reservedSlugs),
    getTenant: (id) => getTenant(db, id),
    getTenantBySlug: (slug) => getTenantBySlug(db, slug),
    listTenants: (query) => listTenants(db, query),
    renameTenant: (id, name) => renameTenant(db, id, name),
    archiveTenant: (id) => archiveTenant(db, id, clock()),
    restoreTenant: (id) => restoreTenant(db, id),

    addMember: (input) => addMember(db, input, clock()),
    getMembership: (tenantId, userId) => getMembership(db, tenantId, userId),
    listMembers: (tenantId) => listMembers(db, tenantId),
    tenantsOf: (userId) => tenantsOf(db, userId),
    setRole: (tenantId, userId, role) => setRole(db, tenantId, userId, role),
    removeMember: (tenantId, userId) => removeMember(db, tenantId, userId),

    resolve: (req, opts) => resolve(db, req, opts),
    authorize: (claim, userId) => authorize(db, claim, userId),

    run: (s, fn) => scope.run(s, fn),
    current: () => scope.current(),
    require: () => scope.require(),

    db: (tenantId) => scopedExecutor(db, tenantId ?? scope.require().tenantId),
    unscopedDb: () => db,
  };
}
