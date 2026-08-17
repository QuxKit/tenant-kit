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
import { type CoverageOptions, type CoverageReport, coverage } from './coverage.ts';
import {
  type AuditEntry,
  ackEvents,
  listAudit,
  listEvents,
  type MutationMeta,
  pollEvents,
  type TenancyEvent,
} from './events.ts';
import {
  acceptInvitation,
  getInvitation,
  invite,
  listInvitations,
  resendInvitation,
  revokeInvitation,
  sweepExpiredInvitations,
} from './invitations.ts';
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
  can,
  defineRole,
  deleteRole,
  getRole,
  listRoles,
  permissionsOf,
  requirePermission,
  updateRole,
} from './roles.ts';
import {
  archiveTenant,
  createTenant,
  createTenantWithOwner,
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
  DefineRoleInput,
  Extractor,
  Invitation,
  InvitationMailer,
  InvitationState,
  InviteInput,
  Logger,
  Membership,
  RequestLike,
  ResolvedTenant,
  Role,
  RoleDefinition,
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
  /**
   * Where invitation tokens are delivered. Without one, `invitations.invite`
   * and `.resend` still return the token for you to deliver yourself.
   */
  invitationMailer?: InvitationMailer;
  /** Default invitation lifetime; seven days unless set. Per-call `ttlMs` wins. */
  invitationTtlMs?: number;
}

/** The outbox and the tenant timeline. */
export interface TenancyEvents {
  /** Unacked events in id order; ack what you handle. */
  poll(query?: { after?: number; limit?: number }): Promise<TenancyEvent[]>;
  ack(ids: readonly number[]): Promise<number>;
  /** One tenant's events, acked or not, oldest first. */
  list(tenantId: TenantId, query?: { after?: number; limit?: number }): Promise<TenancyEvent[]>;
}

/** The audit trail: who did what, per tenant. */
export interface TenancyAudit {
  list(
    tenantId: TenantId,
    query?: { limit?: number; before?: number; actor?: UserId },
  ): Promise<AuditEntry[]>;
}

/** Custom roles and permission questions, namespaced on the instance. */
export interface TenancyRoles {
  /** Idempotent on an identical definition; a different one is `invalid_role`. */
  define(input: DefineRoleInput): Promise<RoleDefinition>;
  update(
    tenantId: TenantId,
    name: string,
    patch: { permissions?: string[]; rank?: number },
  ): Promise<RoleDefinition>;
  /** Refuses with `role_in_use` while any membership or pending invitation names it. */
  delete(tenantId: TenantId, name: string): Promise<void>;
  get(tenantId: TenantId, name: string): Promise<RoleDefinition>;
  /** Built-ins included, by rank. */
  list(tenantId: TenantId): Promise<RoleDefinition[]>;
  /** `false` for non-members; never throws for "no". */
  can(tenantId: TenantId, userId: UserId, permission: string): Promise<boolean>;
  permissionsOf(tenantId: TenantId, userId: UserId): Promise<string[]>;
  /** Throws `permission_denied` (or `not_a_member`). */
  require(tenantId: TenantId, userId: UserId, permission: string): Promise<void>;
}

/** The invitation workflow, namespaced on the instance. */
export interface TenancyInvitations {
  /** Issue; the returned `token` is available exactly once. */
  invite(input: InviteInput): Promise<{ invitation: Invitation; token: string }>;
  /** Token → membership. Idempotent for the same user. */
  accept(input: { token: string; userId: UserId }): Promise<{
    invitation: Invitation;
    membership: Membership;
  }>;
  get(id: string): Promise<Invitation>;
  list(tenantId: TenantId, query?: { state?: InvitationState }): Promise<Invitation[]>;
  revoke(id: string): Promise<Invitation>;
  /** Fresh token, fresh expiry, old token dead. */
  resend(id: string): Promise<{ invitation: Invitation; token: string }>;
  /** Mark timed-out pending invitations expired; returns how many. */
  sweepExpired(): Promise<number>;
}

export interface Tenancy {
  // tenants
  /** With `input.owner`, tenant and first owner land in one transaction. */
  createTenant(input: CreateTenantInput): Promise<Tenant>;
  /** The signup shape: tenant + owner membership, atomically. */
  createTenantWithOwner(
    input: CreateTenantInput & { owner: UserId },
  ): Promise<{ tenant: Tenant; membership: Membership }>;
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
  resolve(
    req: RequestLike,
    options: { userId: UserId; extract: Extractor },
  ): Promise<ResolvedTenant>;
  authorize(claim: TenantClaim, userId: UserId): Promise<ResolvedTenant>;

  // context
  run<T>(scope: ResolvedTenant | TenantId, fn: () => T): T;
  current(): TenantContext | null;
  require(): TenantContext;

  /**
   * An RLS-scoped executor for the given tenant — or, with no argument, for
   * the ambient one, throwing `no_tenant_context` outside `run`. This is the
   * executor to hand to application queries, and to billing-kit.
   *
   * Each `query` on it is its own transaction (BEGIN, SET LOCAL, statement,
   * COMMIT). For a request that runs several statements, `withTenant` opens
   * one transaction and scopes it once.
   */
  db(tenantId?: TenantId): SqlExecutor;

  /**
   * One transaction, one `SET LOCAL`, many statements: the per-request shape.
   *
   * Opens a transaction on the unscoped executor, sets the tenant scope once,
   * runs `fn` with an executor bound to that connection (nested
   * `transaction()` calls on it are savepoints), and commits — or rolls back
   * if `fn` throws. `fn` also runs inside `run(scope, …)`, so `current()` and
   * `require()` see the tenant. `scope` is a `ResolvedTenant` from
   * `resolve()` or, for background work, a bare tenant id.
   */
  withTenant<T>(scope: ResolvedTenant | TenantId, fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;

  /**
   * Which tenant-bearing tables outside `tenancy.*` are under forced RLS
   * with a policy, and which are not. Runs on the unscoped executor; the
   * catalog is readable by any role. `unprotected` should be empty; a
   * startup assertion or CI step that says so is the point.
   */
  coverage(options?: CoverageOptions): Promise<CoverageReport>;

  /** The unscoped executor this instance was built on. Named so that reaching
   *  for it reads as the deliberate act it should be: administrative queries,
   *  cross-tenant reports, the resolve path itself. */
  unscopedDb(): SqlExecutor;

  // invitations
  invitations: TenancyInvitations;

  // roles and permissions
  roles: TenancyRoles;

  // lifecycle events and audit
  events: TenancyEvents;
  audit: TenancyAudit;

  /**
   * The same instance, with every mutation attributed to `actor` in the
   * audit log (and on the event). Without it, the actor is the ambient
   * `ResolvedTenant`'s user when there is one — inside `run(resolved, …)`
   * or `withTenant(resolved, …)` — and absent otherwise, in which case
   * events are still written and audit rows are not. `metadata` is merged
   * into every audit row this handle writes.
   */
  as(actor: UserId, metadata?: Record<string, unknown>): Tenancy;
}

export function createTenancy(options: TenancyOptions): Tenancy {
  return build(options, new TenantScope(), undefined);
}

function build(
  options: TenancyOptions,
  scope: TenantScope,
  bound: MutationMeta | undefined,
): Tenancy {
  const { db, reservedSlugs } = options;
  const clock: Clock = options.clock ?? (() => new Date());
  const invitationOptions = { mailer: options.invitationMailer, ttlMs: options.invitationTtlMs };
  // Who is acting: the explicit `as(actor)`, else the ambient resolved user.
  const meta = (): MutationMeta | undefined => {
    if (bound !== undefined) return bound;
    const actor = scope.current()?.membership?.userId;
    return actor === undefined ? undefined : { actor };
  };

  return {
    createTenant: (input) => createTenant(db, input, clock(), reservedSlugs, meta()),
    createTenantWithOwner: (input) =>
      createTenantWithOwner(db, input, clock(), reservedSlugs, meta()),
    getTenant: (id) => getTenant(db, id),
    getTenantBySlug: (slug) => getTenantBySlug(db, slug),
    listTenants: (query) => listTenants(db, query),
    renameTenant: (id, name) => renameTenant(db, id, name, clock(), meta()),
    archiveTenant: (id) => archiveTenant(db, id, clock(), meta()),
    restoreTenant: (id) => restoreTenant(db, id, clock(), meta()),

    addMember: (input) => addMember(db, input, clock(), meta()),
    getMembership: (tenantId, userId) => getMembership(db, tenantId, userId),
    listMembers: (tenantId) => listMembers(db, tenantId),
    tenantsOf: (userId) => tenantsOf(db, userId),
    setRole: (tenantId, userId, role) => setRole(db, tenantId, userId, role, clock(), meta()),
    removeMember: (tenantId, userId) => removeMember(db, tenantId, userId, clock(), meta()),

    resolve: (req, opts) => resolve(db, req, opts),
    authorize: (claim, userId) => authorize(db, claim, userId),

    run: (s, fn) => scope.run(s, fn),
    current: () => scope.current(),
    require: () => scope.require(),

    db: (tenantId) => scopedExecutor(db, tenantId ?? scope.require().tenantId),
    withTenant: (s, fn) => {
      const tenantId = typeof s === 'string' ? s : s.tenant.id;
      return scope.run(s, () => scopedExecutor(db, tenantId).transaction(fn));
    },
    unscopedDb: () => db,
    coverage: (opts) => coverage(db, opts),

    invitations: {
      invite: (input) => invite(db, input, clock(), invitationOptions, meta()),
      accept: (input) => acceptInvitation(db, input, clock(), meta()),
      get: (id) => getInvitation(db, id, clock()),
      list: (tenantId, query) => listInvitations(db, tenantId, clock(), query),
      revoke: (id) => revokeInvitation(db, id, clock(), meta()),
      resend: (id) => resendInvitation(db, id, clock(), invitationOptions, meta()),
      sweepExpired: () => sweepExpiredInvitations(db, clock(), meta()),
    },

    roles: {
      define: (input) => defineRole(db, input, clock(), meta()),
      update: (tenantId, name, patch) => updateRole(db, tenantId, name, patch, clock(), meta()),
      delete: (tenantId, name) => deleteRole(db, tenantId, name, clock(), meta()),
      get: (tenantId, name) => getRole(db, tenantId, name),
      list: (tenantId) => listRoles(db, tenantId),
      can: (tenantId, userId, permission) => can(db, tenantId, userId, permission),
      permissionsOf: (tenantId, userId) => permissionsOf(db, tenantId, userId),
      require: (tenantId, userId, permission) =>
        requirePermission(db, tenantId, userId, permission),
    },

    events: {
      poll: (query) => pollEvents(db, query),
      ack: (ids) => ackEvents(db, ids, clock()),
      list: (tenantId, query) => listEvents(db, tenantId, query),
    },
    audit: {
      list: (tenantId, query) => listAudit(db, tenantId, query),
    },

    as: (actor, metadata) => build(options, scope, { actor, metadata }),
  };
}
