// Membership: who belongs to a tenant, and as what.
//
// One invariant lives here and shapes every write: a tenant always has at
// least one owner. Not "usually", not "unless someone raced the check" — the
// demote and remove paths take row locks on the tenant's owner rows before
// counting them, so two concurrent removals of the last two owners serialize
// and the second one fails. A tenant with no owner is a tenant nobody can
// administer again without a DBA, and "ask the DBA" is not an API.

import { TenancyError } from './errors.ts';
import { type TenantRow, toTenant } from './tenants.ts';
import type {
  AddMemberInput,
  BuiltinRole,
  Membership,
  Role,
  SqlExecutor,
  Tenant,
  TenantId,
  UserId,
} from './types.ts';

// --- roles ------------------------------------------------------------------

const RANK: Record<BuiltinRole, number> = { member: 0, admin: 1, owner: 2 };

export function isBuiltinRole(value: string): value is BuiltinRole {
  return value === 'owner' || value === 'admin' || value === 'member';
}

/** @deprecated Renamed `isBuiltinRole`; custom roles made "is a role" tenant-relative. */
export const isRole = isBuiltinRole;

/**
 * Same shape as a slug, and for the same reason: role names end up in URLs
 * and config files.
 */
const ROLE_NAME = /^[a-z][a-z0-9_-]*$/;

export function isRoleName(value: string): boolean {
  return value.length > 0 && value.length <= 63 && ROLE_NAME.test(value);
}

/**
 * `atLeast('admin', 'member')` — does the first role cover the second, on
 * the built-in ladder? A custom role is not on it and answers `false` for
 * every `need`: custom roles carry permissions, not standing, and the
 * question to ask about one is `can(...)`.
 */
export function atLeast(have: Role, need: BuiltinRole): boolean {
  return isBuiltinRole(have) && RANK[have] >= RANK[need];
}

/**
 * The built-in-ladder check. Throws `forbidden` carrying both roles, so the
 * caller's 403 can say what was missing without composing strings out of
 * band. For custom roles and application permissions, `requirePermission`.
 */
export function requireRole(membership: Membership, need: BuiltinRole): void {
  if (!atLeast(membership.role, need))
    throw new TenancyError({
      code: 'forbidden',
      tenantId: membership.tenantId,
      userId: membership.userId,
      need,
      have: membership.role,
    });
}

// --- rows -------------------------------------------------------------------

export interface MembershipRow {
  tenant_id: string;
  user_id: string;
  role: string;
  created_at: Date;
}

export function toMembership(row: MembershipRow): Membership {
  return {
    tenantId: row.tenant_id,
    userId: row.user_id,
    role: row.role as Role,
    createdAt: row.created_at,
  };
}

const SELECT = `SELECT tenant_id, user_id, role, created_at FROM tenancy.memberships`;

/**
 * Assert that `role` is assignable in this tenant, and — for a custom role —
 * hold a share lock on its row for the rest of `tx`. Called by `addMember`,
 * `setRole` and `invite` inside their transactions. Built-ins pass without
 * touching the store; the share lock is what makes `deleteRole`'s
 * `FOR UPDATE` wait for (or be waited on by) an in-flight assignment.
 */
export async function assertRoleAssignable(
  tx: SqlExecutor,
  tenantId: TenantId,
  role: string,
): Promise<void> {
  if (isBuiltinRole(role)) return;
  if (!isRoleName(role)) throw new TenancyError({ code: 'invalid_role', role });
  const rows = await tx.query<{ name: string }>(
    `SELECT name FROM tenancy.roles WHERE tenant_id = $1 AND name = $2 FOR SHARE`,
    [tenantId, role],
  );
  if (rows.length === 0) throw new TenancyError({ code: 'unknown_role', tenantId, role });
}

// --- operations -------------------------------------------------------------

/**
 * Add a member, idempotently: re-adding with the same role returns the
 * existing membership; the same user with a different role is
 * `already_a_member`, because silently changing a role on what looked like an
 * insert is a privilege change nobody reviewed. Role changes go through
 * `setRole`, which enforces the owner invariant.
 */
export async function addMember(
  db: SqlExecutor,
  input: AddMemberInput,
  now: Date,
): Promise<Membership> {
  if (!isRoleName(input.role)) throw new TenancyError({ code: 'invalid_role', role: input.role });
  if (input.userId.trim().length === 0)
    throw new TenancyError({ code: 'invalid_tenant', field: 'userId', reason: 'empty' });

  const inserted = await db.transaction(async (tx) => {
    await assertRoleAssignable(tx, input.tenantId, input.role);
    return tx.query<MembershipRow>(
      `INSERT INTO tenancy.memberships (tenant_id, user_id, role, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, user_id) DO NOTHING
       RETURNING tenant_id, user_id, role, created_at`,
      [input.tenantId, input.userId, input.role, now],
    );
  });
  if (inserted.length === 1) return toMembership(inserted[0]);

  const existing = await getMembership(db, input.tenantId, input.userId);
  if (existing.role === input.role) return existing;
  throw new TenancyError({
    code: 'already_a_member',
    tenantId: input.tenantId,
    userId: input.userId,
    role: existing.role,
  });
}

export async function getMembership(
  db: SqlExecutor,
  tenantId: TenantId,
  userId: UserId,
): Promise<Membership> {
  const rows = await db.query<MembershipRow>(`${SELECT} WHERE tenant_id = $1 AND user_id = $2`, [
    tenantId,
    userId,
  ]);
  if (rows.length === 0) throw new TenancyError({ code: 'not_a_member', tenantId, userId });
  return toMembership(rows[0]);
}

export async function listMembers(db: SqlExecutor, tenantId: TenantId): Promise<Membership[]> {
  const rows = await db.query<MembershipRow>(
    `${SELECT} WHERE tenant_id = $1 ORDER BY created_at, user_id`,
    [tenantId],
  );
  return rows.map(toMembership);
}

/** Every tenant a user belongs to, with their standing — the tenant-switcher query. */
export async function tenantsOf(
  db: SqlExecutor,
  userId: UserId,
): Promise<Array<{ tenant: Tenant; membership: Membership }>> {
  const rows = await db.query<TenantRow & MembershipRow & { member_since: Date }>(
    `SELECT t.id, t.slug, t.name, t.state, t.created_at, t.archived_at,
            m.tenant_id, m.user_id, m.role, m.created_at AS member_since
       FROM tenancy.memberships m
       JOIN tenancy.tenants t ON t.id = m.tenant_id
      WHERE m.user_id = $1
      ORDER BY t.created_at, t.id`,
    [userId],
  );
  return rows.map((row) => ({
    tenant: toTenant(row),
    membership: toMembership({ ...row, created_at: row.member_since }),
  }));
}

/**
 * Lock this tenant's owner rows *and* the row of the user being changed, in
 * one statement, in one order.
 *
 * `FOR UPDATE` is the point: the owner count is only trustworthy for the rest
 * of the transaction if nobody else can delete an owner row while we hold it.
 * The single statement with `ORDER BY user_id` is the other point: two
 * concurrent removals of the last two owners each want both rows, and if each
 * took its own row first and the other's second they would deadlock (40P01)
 * instead of serializing. Postgres locks rows in output order, so with the
 * same ORDER BY on both sides the second transaction simply waits on the
 * first row it cannot get, then sees the world after the first commits.
 */
async function lockOwnersAnd(
  tx: SqlExecutor,
  tenantId: TenantId,
  userId: UserId,
): Promise<{ target: MembershipRow | undefined; owners: number }> {
  const rows = await tx.query<MembershipRow>(
    `SELECT tenant_id, user_id, role, created_at FROM tenancy.memberships
      WHERE tenant_id = $1 AND (role = 'owner' OR user_id = $2)
      ORDER BY user_id
      FOR UPDATE`,
    [tenantId, userId],
  );
  return {
    target: rows.find((r) => r.user_id === userId),
    owners: rows.filter((r) => r.role === 'owner').length,
  };
}

export async function setRole(
  db: SqlExecutor,
  tenantId: TenantId,
  userId: UserId,
  role: Role,
): Promise<Membership> {
  if (!isRoleName(role)) throw new TenancyError({ code: 'invalid_role', role });
  return db.transaction(async (tx) => {
    const { target, owners } = await lockOwnersAnd(tx, tenantId, userId);
    if (target === undefined) throw new TenancyError({ code: 'not_a_member', tenantId, userId });
    const current = toMembership(target);
    if (current.role === role) return current;
    await assertRoleAssignable(tx, tenantId, role);
    if (current.role === 'owner' && owners === 1)
      throw new TenancyError({ code: 'last_owner', tenantId, userId });
    const rows = await tx.query<MembershipRow>(
      `UPDATE tenancy.memberships SET role = $3
        WHERE tenant_id = $1 AND user_id = $2
       RETURNING tenant_id, user_id, role, created_at`,
      [tenantId, userId, role],
    );
    return toMembership(rows[0]);
  });
}

/**
 * Idempotent: removing an absent membership is a no-op, because the state the
 * caller asked for — "this user is not a member" — already holds, and a retry
 * of a remove should not error. Removing the last owner is the one refusal.
 */
export async function removeMember(
  db: SqlExecutor,
  tenantId: TenantId,
  userId: UserId,
): Promise<void> {
  await db.transaction(async (tx) => {
    const { target, owners } = await lockOwnersAnd(tx, tenantId, userId);
    if (target === undefined) return;
    if (target.role === 'owner' && owners === 1)
      throw new TenancyError({ code: 'last_owner', tenantId, userId });
    await tx.query(`DELETE FROM tenancy.memberships WHERE tenant_id = $1 AND user_id = $2`, [
      tenantId,
      userId,
    ]);
  });
}
