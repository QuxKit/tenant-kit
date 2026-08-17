// Roles and permissions: the built-in three, plus whatever a tenant defines.
//
// The scope line, restated so this file does not drift across it: a role is
// a *name* with a flat list of permission strings and a rank. The strings
// are the host application's vocabulary — `projects:write`, `billing:read`
// — and the only matching this library does is exact, `ns:*`, or `*`. No
// resources, no relations, no inheritance graph. That is an RBAC engine's
// job, and tenant-kit-adapters bridges to one; what this file adds is enough
// that a tenant can have a "billing" role without the host building a
// parallel permissions table and keeping it in step with memberships.
//
// The built-ins are implied: no row, not deletable, not redefinable, and
// their permission sets are the constants below. `atLeast` / `requireRole`
// still order them; a custom role does not sit on that ladder — ask `can`.
//
// The one invariant here is that a role in use cannot vanish. `deleteRole`
// locks the role row `FOR UPDATE` and counts memberships and pending
// invitations that name it; every write that *assigns* a custom role first
// takes `FOR SHARE` on that row in the same transaction. The two lock modes
// conflict, so an assign and a delete serialize, and whichever comes second
// sees the other's outcome.

import { TenancyError } from './errors.ts';
import { getMembership, isBuiltinRole, isRoleName } from './members.ts';
import type {
  BuiltinRole,
  DefineRoleInput,
  RoleDefinition,
  SqlExecutor,
  TenantId,
  UserId,
} from './types.ts';

// --- built-ins --------------------------------------------------------------

/**
 * The default permission set of each built-in role. Application vocabulary
 * that every QuxKit kit and adapter can rely on being present:
 *
 *   tenant:read       see the tenant's name, slug and settings
 *   tenant:write      rename it, change settings
 *   tenant:archive    archive / restore it
 *   members:read      list members and their roles
 *   members:write     add, remove, change the role of members
 *   invitations:read  list invitations
 *   invitations:write invite, revoke, resend
 *   roles:read        list roles and permissions
 *   roles:write       define, update, delete custom roles
 *
 * `owner` holds `*` — everything, including whatever your app defines later
 * — because an owner locked out of a new feature by a missing string is a
 * support ticket, not a security property. Custom roles hold exactly what
 * they are given.
 */
export const BUILTIN_ROLES: Readonly<
  Record<BuiltinRole, { rank: number; permissions: readonly string[] }>
> = Object.freeze({
  member: Object.freeze({
    rank: 0,
    permissions: Object.freeze(['tenant:read', 'members:read', 'roles:read']),
  }),
  admin: Object.freeze({
    rank: 100,
    permissions: Object.freeze([
      'tenant:read',
      'tenant:write',
      'members:read',
      'members:write',
      'invitations:read',
      'invitations:write',
      'roles:read',
      'roles:write',
    ]),
  }),
  owner: Object.freeze({ rank: 200, permissions: Object.freeze(['*']) }),
});

/**
 * Same shape as a slug, and for the same reason: role names end up in URLs
 * and config files. Reserved names are the built-ins.
 */
export function validateRoleName(name: string): void {
  if (!isRoleName(name))
    throw new TenancyError({
      code: 'invalid_role',
      role: name,
      reason: 'must be lowercase letters, digits, _ or -, starting with a letter, at most 63',
    });
  if (isBuiltinRole(name))
    throw new TenancyError({ code: 'invalid_role', role: name, reason: 'reserved (built-in)' });
}

/** Permission strings: non-empty, no whitespace. `*` and `ns:*` are wildcards. */
const PERMISSION = /^\S+$/;

function normalizePermissions(permissions: readonly string[]): string[] {
  const out = new Set<string>();
  for (const p of permissions) {
    if (!PERMISSION.test(p))
      throw new TenancyError({
        code: 'invalid_tenant',
        field: 'permissions',
        reason: `not a permission: ${JSON.stringify(p)}`,
      });
    out.add(p);
  }
  return [...out].sort();
}

// --- matching ---------------------------------------------------------------

/**
 * Does a granted list cover a permission? Exact match, `*`, or `ns:*` where
 * `ns` is everything before the permission's first colon (so `a:*` covers
 * `a:b` and `a:b:c` alike). Nothing deeper, and wildcards in the *asked*
 * permission are not interpreted — asking `can(..., 'a:*')` is asking for
 * that literal string.
 */
export function hasPermission(granted: readonly string[], permission: string): boolean {
  if (granted.includes('*') || granted.includes(permission)) return true;
  const colon = permission.indexOf(':');
  if (colon <= 0) return false;
  return granted.includes(`${permission.slice(0, colon)}:*`);
}

// --- rows -------------------------------------------------------------------

interface RoleRow {
  tenant_id: string;
  name: string;
  permissions: string[];
  rank: number;
}

const COLUMNS = 'tenant_id, name, permissions, rank';

function toRole(row: RoleRow): RoleDefinition {
  return {
    tenantId: row.tenant_id,
    name: row.name,
    permissions: [...row.permissions],
    rank: row.rank,
    builtin: false,
  };
}

function builtin(tenantId: TenantId, name: BuiltinRole): RoleDefinition {
  return {
    tenantId,
    name,
    permissions: [...BUILTIN_ROLES[name].permissions],
    rank: BUILTIN_ROLES[name].rank,
    builtin: true,
  };
}

// --- definitions ------------------------------------------------------------

/**
 * Define a custom role, idempotently: same name, same permissions, same rank
 * returns the existing definition; a different definition under an existing
 * name is `invalid_role` with the reason — changing a role is `updateRole`,
 * a distinct call because it changes what every holder can do.
 */
export async function defineRole(
  db: SqlExecutor,
  input: DefineRoleInput,
  now: Date,
): Promise<RoleDefinition> {
  validateRoleName(input.name);
  const permissions = normalizePermissions(input.permissions);
  const rank = input.rank ?? 0;
  if (!Number.isInteger(rank) || rank < 0)
    throw new TenancyError({
      code: 'invalid_tenant',
      field: 'rank',
      reason: 'must be a non-negative integer',
    });

  const inserted = await db.query<RoleRow>(
    `INSERT INTO tenancy.roles (tenant_id, name, permissions, rank, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT (tenant_id, name) DO NOTHING
     RETURNING ${COLUMNS}`,
    [input.tenantId, input.name, permissions, rank, now],
  );
  if (inserted.length === 1) return toRole(inserted[0]);

  const existing = await getRole(db, input.tenantId, input.name);
  if (existing.rank === rank && sameList(existing.permissions, permissions)) return existing;
  throw new TenancyError({
    code: 'invalid_role',
    role: input.name,
    reason: 'already defined with different permissions or rank; use updateRole',
  });
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Replace a custom role's permissions and/or rank. Built-ins are `invalid_role`. */
export async function updateRole(
  db: SqlExecutor,
  tenantId: TenantId,
  name: string,
  patch: { permissions?: string[]; rank?: number },
  now: Date,
): Promise<RoleDefinition> {
  if (isBuiltinRole(name))
    throw new TenancyError({
      code: 'invalid_role',
      role: name,
      reason: 'built-in roles are fixed',
    });
  const permissions =
    patch.permissions === undefined ? null : normalizePermissions(patch.permissions);
  if (patch.rank !== undefined && (!Number.isInteger(patch.rank) || patch.rank < 0))
    throw new TenancyError({
      code: 'invalid_tenant',
      field: 'rank',
      reason: 'must be a non-negative integer',
    });
  const rows = await db.query<RoleRow>(
    `UPDATE tenancy.roles
        SET permissions = COALESCE($3, permissions),
            rank        = COALESCE($4, rank),
            updated_at  = $5
      WHERE tenant_id = $1 AND name = $2
      RETURNING ${COLUMNS}`,
    [tenantId, name, permissions, patch.rank ?? null, now],
  );
  if (rows.length === 0) throw new TenancyError({ code: 'unknown_role', tenantId, role: name });
  return toRole(rows[0]);
}

/**
 * Delete a custom role nobody holds. Refuses with `role_in_use` — carrying
 * the counts — while any membership or pending invitation names it. The
 * check runs under `FOR UPDATE` on the role row, which is what every
 * assignment of a custom role takes `FOR SHARE` on, so an assign racing this
 * delete lands on one side or the other, never through the middle.
 * Idempotent: deleting a role that does not exist is a no-op.
 */
export async function deleteRole(db: SqlExecutor, tenantId: TenantId, name: string): Promise<void> {
  if (isBuiltinRole(name))
    throw new TenancyError({
      code: 'invalid_role',
      role: name,
      reason: 'built-in roles are fixed',
    });
  await db.transaction(async (tx) => {
    const locked = await tx.query<{ name: string }>(
      `SELECT name FROM tenancy.roles WHERE tenant_id = $1 AND name = $2 FOR UPDATE`,
      [tenantId, name],
    );
    if (locked.length === 0) return;
    const [{ members, invitations }] = await tx.query<{ members: string; invitations: string }>(
      `SELECT (SELECT count(*) FROM tenancy.memberships WHERE tenant_id = $1 AND role = $2) AS members,
              (SELECT count(*) FROM tenancy.invitations
                WHERE tenant_id = $1 AND role = $2 AND state = 'pending') AS invitations`,
      [tenantId, name],
    );
    if (Number(members) > 0 || Number(invitations) > 0)
      throw new TenancyError({
        code: 'role_in_use',
        tenantId,
        role: name,
        members: Number(members),
        invitations: Number(invitations),
      });
    await tx.query(`DELETE FROM tenancy.roles WHERE tenant_id = $1 AND name = $2`, [
      tenantId,
      name,
    ]);
  });
}

/** A role by name — built-in or custom — or `unknown_role`. */
export async function getRole(
  db: SqlExecutor,
  tenantId: TenantId,
  name: string,
): Promise<RoleDefinition> {
  if (isBuiltinRole(name)) return builtin(tenantId, name);
  const rows = await db.query<RoleRow>(
    `SELECT ${COLUMNS} FROM tenancy.roles WHERE tenant_id = $1 AND name = $2`,
    [tenantId, name],
  );
  if (rows.length === 0) throw new TenancyError({ code: 'unknown_role', tenantId, role: name });
  return toRole(rows[0]);
}

/** Every role the tenant has, built-ins included, by rank then name. */
export async function listRoles(db: SqlExecutor, tenantId: TenantId): Promise<RoleDefinition[]> {
  const rows = await db.query<RoleRow>(
    `SELECT ${COLUMNS} FROM tenancy.roles WHERE tenant_id = $1`,
    [tenantId],
  );
  const all = [
    builtin(tenantId, 'member'),
    builtin(tenantId, 'admin'),
    builtin(tenantId, 'owner'),
    ...rows.map(toRole),
  ];
  return all.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
}

// --- questions --------------------------------------------------------------

/**
 * The permission strings a user holds in a tenant, via their role. Throws
 * `not_a_member` — and, should a membership name a role that no longer
 * exists (only possible by writing around the library), `unknown_role`,
 * loudly, rather than treating a dangling role as an empty one.
 */
export async function permissionsOf(
  db: SqlExecutor,
  tenantId: TenantId,
  userId: UserId,
): Promise<string[]> {
  const membership = await getMembership(db, tenantId, userId);
  return (await getRole(db, tenantId, membership.role)).permissions;
}

/**
 * Yes or no: does this user hold `permission` here? Not a member is `false`,
 * not an error — this is the shape for a UI deciding whether to show a
 * button. For a guard that should throw, use `requirePermission`.
 */
export async function can(
  db: SqlExecutor,
  tenantId: TenantId,
  userId: UserId,
  permission: string,
): Promise<boolean> {
  try {
    return hasPermission(await permissionsOf(db, tenantId, userId), permission);
  } catch (error) {
    if (TenancyError.hasCode(error, 'not_a_member')) return false;
    throw error;
  }
}

/** `can`, as a guard: throws `permission_denied` (or `not_a_member`). */
export async function requirePermission(
  db: SqlExecutor,
  tenantId: TenantId,
  userId: UserId,
  permission: string,
): Promise<void> {
  if (!hasPermission(await permissionsOf(db, tenantId, userId), permission))
    throw new TenancyError({ code: 'permission_denied', tenantId, userId, permission });
}
