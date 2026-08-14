// Membership: who belongs to a tenant, and as what.
//
// One invariant lives here and shapes every write: a tenant always has at
// least one owner. Not "usually", not "unless someone raced the check" — the
// demote and remove paths take row locks on the tenant's owner rows before
// counting them, so two concurrent removals of the last two owners serialize
// and the second one fails. A tenant with no owner is a tenant nobody can
// administer again without a DBA, and "ask the DBA" is not an API.

import { TenancyError } from './errors.ts';
import type {
  AddMemberInput,
  Membership,
  Role,
  SqlExecutor,
  Tenant,
  TenantId,
  UserId,
} from './types.ts';
import { toTenant, type TenantRow } from './tenants.ts';

// --- roles ------------------------------------------------------------------

const RANK: Record<Role, number> = { member: 0, admin: 1, owner: 2 };

export function isRole(value: string): value is Role {
  return value === 'owner' || value === 'admin' || value === 'member';
}

/** `atLeast('admin', 'member')` — does the first role cover the second? */
export function atLeast(have: Role, need: Role): boolean {
  return RANK[have] >= RANK[need];
}

/**
 * The only permission check this library does. Throws `forbidden` carrying
 * both roles, so the caller's 403 can say what was missing without composing
 * strings out of band.
 */
export function requireRole(membership: Membership, need: Role): void {
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
  if (!isRole(input.role)) throw new TenancyError({ code: 'invalid_role', role: input.role });
  if (input.userId.trim().length === 0)
    throw new TenancyError({ code: 'invalid_tenant', field: 'userId', reason: 'empty' });

  const inserted = await db.query<MembershipRow>(
    `INSERT INTO tenancy.memberships (tenant_id, user_id, role, created_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, user_id) DO NOTHING
     RETURNING tenant_id, user_id, role, created_at`,
    [input.tenantId, input.userId, input.role, now],
  );
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
 * Lock this tenant's owner rows and count them. `FOR UPDATE` is the point:
 * the count is only trustworthy for the rest of the transaction if nobody
 * else can delete an owner row while we hold it.
 */
async function lockedOwnerCount(tx: SqlExecutor, tenantId: TenantId): Promise<number> {
  const rows = await tx.query<{ user_id: string }>(
    `SELECT user_id FROM tenancy.memberships
      WHERE tenant_id = $1 AND role = 'owner' FOR UPDATE`,
    [tenantId],
  );
  return rows.length;
}

export async function setRole(
  db: SqlExecutor,
  tenantId: TenantId,
  userId: UserId,
  role: Role,
): Promise<Membership> {
  if (!isRole(role)) throw new TenancyError({ code: 'invalid_role', role });
  return db.transaction(async (tx) => {
    const current = await getMembership(tx, tenantId, userId);
    if (current.role === role) return current;
    if (current.role === 'owner' && (await lockedOwnerCount(tx, tenantId)) === 1)
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
    const rows = await tx.query<{ role: string }>(
      `SELECT role FROM tenancy.memberships
        WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE`,
      [tenantId, userId],
    );
    if (rows.length === 0) return;
    if (rows[0].role === 'owner' && (await lockedOwnerCount(tx, tenantId)) === 1)
      throw new TenancyError({ code: 'last_owner', tenantId, userId });
    await tx.query(`DELETE FROM tenancy.memberships WHERE tenant_id = $1 AND user_id = $2`, [
      tenantId,
      userId,
    ]);
  });
}
