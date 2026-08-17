// The tenants themselves: creation, lookup, rename, archive.
//
// Free functions taking `(db, …, now)`, same shape as billing-kit's core:
// configuration as an argument, never a module global, so two instances — a
// test on a rolled-back executor, a worker per region — coexist in one
// process. `instance.ts` binds the arguments once for call sites.

import { randomUUID } from 'node:crypto';
import { TenancyError } from './errors.ts';
import type {
  CreateTenantInput,
  Membership,
  SqlExecutor,
  Tenant,
  TenantId,
  UserId,
} from './types.ts';

// --- slugs ------------------------------------------------------------------

/**
 * DNS-label rules, because the slug's job is to appear in hostnames: lowercase
 * letters, digits, single interior hyphens, at most 63 characters. Anything
 * looser works right up until the first `acme_corp.example.com` certificate
 * request fails.
 */
const SLUG = /^[a-z0-9](?:-?[a-z0-9])*$/;

/**
 * Slugs that route somewhere before tenant resolution ever runs. A tenant
 * named `www` does not get traffic — the wildcard record's other bindings do —
 * so refusing them at creation is kinder than debugging them at resolution.
 * Extensible because every deployment has its own reserved surface.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'www',
  'api',
  'app',
  'admin',
  'assets',
  'static',
  'mail',
  'internal',
]);

export function validateSlug(slug: string, reserved: ReadonlySet<string> = RESERVED_SLUGS): void {
  if (slug.length === 0) throw new TenancyError({ code: 'invalid_slug', slug, reason: 'empty' });
  if (slug.length > 63)
    throw new TenancyError({ code: 'invalid_slug', slug, reason: 'longer than a DNS label (63)' });
  if (!SLUG.test(slug))
    throw new TenancyError({
      code: 'invalid_slug',
      slug,
      reason: 'must be lowercase letters, digits and single interior hyphens',
    });
  if (reserved.has(slug))
    throw new TenancyError({ code: 'invalid_slug', slug, reason: 'reserved' });
}

// --- rows -------------------------------------------------------------------

export interface TenantRow {
  id: string;
  slug: string;
  name: string;
  state: string;
  created_at: Date;
  archived_at: Date | null;
}

export function toTenant(row: TenantRow): Tenant {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    state: row.state as Tenant['state'],
    createdAt: row.created_at,
    archivedAt: row.archived_at,
  };
}

const SELECT = `SELECT id, slug, name, state, created_at, archived_at
  FROM tenancy.tenants`;

// --- operations -------------------------------------------------------------

/**
 * Create a tenant, idempotently: the slug is the natural key. Creating again
 * with the same slug and name returns the existing row; the same slug with a
 * different name is `slug_taken`, because answering a request that was never
 * made with a row that happens to share a key is how retries paper over bugs.
 *
 * Race-safe via `ON CONFLICT DO NOTHING` + re-select, not read-then-insert:
 * two concurrent creates of one slug both land here, one inserts, both then
 * read the same winning row and judge it against their own input.
 *
 * With `input.owner` set this delegates to `createTenantWithOwner`, so the
 * tenant and its first owner land in one transaction. Without it, the tenant
 * has no owner until `addMember` runs — the shape for imports and migrations
 * that bring their own membership rows, and not the one for a signup flow.
 */
export async function createTenant(
  db: SqlExecutor,
  input: CreateTenantInput,
  now: Date,
  reserved?: ReadonlySet<string>,
): Promise<Tenant> {
  if (input.owner !== undefined) {
    const { tenant } = await createTenantWithOwner(
      db,
      { ...input, owner: input.owner },
      now,
      reserved,
    );
    return tenant;
  }
  validateSlug(input.slug, reserved);
  if (input.name.trim().length === 0)
    throw new TenancyError({ code: 'invalid_tenant', field: 'name', reason: 'empty' });
  return (await insertTenant(db, input, now)).tenant;
}

async function insertTenant(
  db: SqlExecutor,
  input: CreateTenantInput,
  now: Date,
): Promise<{ tenant: Tenant; created: boolean }> {
  const id = input.id ?? randomUUID();
  const inserted = await db.query<TenantRow>(
    `INSERT INTO tenancy.tenants (id, slug, name, state, created_at)
     VALUES ($1, $2, $3, 'active', $4)
     ON CONFLICT (slug) DO NOTHING
     RETURNING id, slug, name, state, created_at, archived_at`,
    [id, input.slug, input.name, now],
  );
  if (inserted.length === 1) return { tenant: toTenant(inserted[0]), created: true };

  const existing = await getTenantBySlug(db, input.slug);
  if (existing.name === input.name && existing.state === 'active')
    return { tenant: existing, created: false };
  throw new TenancyError({
    code: 'slug_taken',
    slug: input.slug,
    detail:
      existing.state !== 'active'
        ? `existing tenant is ${existing.state}`
        : `existing tenant is named ${JSON.stringify(existing.name)}, not ${JSON.stringify(input.name)}`,
  });
}

/**
 * Create a tenant and its first owner in one transaction.
 *
 * This is the signup-flow shape: no committed state ever holds a tenant with
 * zero owners, so a crash between "create tenant" and "add owner" cannot
 * leave a tenant nobody can administer. Idempotent on an exact retry — same
 * slug, same name, same owner — which returns the existing pair. A retry that
 * names a *different* owner for an existing tenant is `slug_taken`: granting
 * ownership of someone else's tenant is not what a create means, and the
 * caller who wants that goes through `addMember` under the owner's authority.
 *
 * The membership insert is written out here rather than calling `addMember`
 * because members.ts imports this module for `toTenant`; the SQL is the same
 * ON CONFLICT DO NOTHING shape and lives in the same transaction.
 */
export async function createTenantWithOwner(
  db: SqlExecutor,
  input: CreateTenantInput & { owner: UserId },
  now: Date,
  reserved?: ReadonlySet<string>,
): Promise<{ tenant: Tenant; membership: Membership }> {
  validateSlug(input.slug, reserved);
  if (input.name.trim().length === 0)
    throw new TenancyError({ code: 'invalid_tenant', field: 'name', reason: 'empty' });
  if (input.owner.trim().length === 0)
    throw new TenancyError({ code: 'invalid_tenant', field: 'owner', reason: 'empty' });

  return db.transaction(async (tx) => {
    const { tenant, created } = await insertTenant(tx, input, now);
    const rows = created
      ? await tx.query<MembershipRowLite>(
          `INSERT INTO tenancy.memberships (tenant_id, user_id, role, created_at)
           VALUES ($1, $2, 'owner', $3)
           RETURNING tenant_id, user_id, role, created_at`,
          [tenant.id, input.owner, now],
        )
      : await tx.query<MembershipRowLite>(
          `SELECT tenant_id, user_id, role, created_at FROM tenancy.memberships
            WHERE tenant_id = $1 AND user_id = $2 AND role = 'owner'`,
          [tenant.id, input.owner],
        );
    if (rows.length === 0)
      throw new TenancyError({
        code: 'slug_taken',
        slug: input.slug,
        detail: `existing tenant does not have ${input.owner} as an owner`,
      });
    const row = rows[0];
    return {
      tenant,
      membership: {
        tenantId: row.tenant_id,
        userId: row.user_id,
        role: 'owner',
        createdAt: row.created_at,
      },
    };
  });
}

/** The membership row shape, redeclared here to keep this module free of members.ts. */
interface MembershipRowLite {
  tenant_id: string;
  user_id: string;
  role: string;
  created_at: Date;
}

export async function getTenant(db: SqlExecutor, id: TenantId): Promise<Tenant> {
  const rows = await db.query<TenantRow>(`${SELECT} WHERE id = $1`, [id]);
  if (rows.length === 0) throw new TenancyError({ code: 'unknown_tenant', ref: id });
  return toTenant(rows[0]);
}

export async function getTenantBySlug(db: SqlExecutor, slug: string): Promise<Tenant> {
  const rows = await db.query<TenantRow>(`${SELECT} WHERE slug = $1`, [slug]);
  if (rows.length === 0) throw new TenancyError({ code: 'unknown_tenant', ref: slug });
  return toTenant(rows[0]);
}

export async function listTenants(
  db: SqlExecutor,
  query: { state?: Tenant['state'] } = {},
): Promise<Tenant[]> {
  const rows =
    query.state === undefined
      ? await db.query<TenantRow>(`${SELECT} ORDER BY created_at, id`)
      : await db.query<TenantRow>(`${SELECT} WHERE state = $1 ORDER BY created_at, id`, [
          query.state,
        ]);
  return rows.map(toTenant);
}

export async function renameTenant(db: SqlExecutor, id: TenantId, name: string): Promise<Tenant> {
  if (name.trim().length === 0)
    throw new TenancyError({ code: 'invalid_tenant', field: 'name', reason: 'empty' });
  const rows = await db.query<TenantRow>(
    `UPDATE tenancy.tenants SET name = $2 WHERE id = $1
     RETURNING id, slug, name, state, created_at, archived_at`,
    [id, name],
  );
  if (rows.length === 0) throw new TenancyError({ code: 'unknown_tenant', ref: id });
  return toTenant(rows[0]);
}

/**
 * Archive, not delete. The tenant's rows across the host schema — and across
 * billing-kit's ledger, if it is running — still reference this id, and a
 * ledger whose tenant vanished cannot explain itself in an audit. Archived
 * tenants fail `resolve()` with `tenant_archived`; their data outlives them.
 * Idempotent: archiving an archived tenant keeps the original `archived_at`,
 * because the first archival is the fact and a retry is not a second fact.
 */
export async function archiveTenant(db: SqlExecutor, id: TenantId, now: Date): Promise<Tenant> {
  const rows = await db.query<TenantRow>(
    `UPDATE tenancy.tenants
        SET state = 'archived', archived_at = COALESCE(archived_at, $2)
      WHERE id = $1
     RETURNING id, slug, name, state, created_at, archived_at`,
    [id, now],
  );
  if (rows.length === 0) throw new TenancyError({ code: 'unknown_tenant', ref: id });
  return toTenant(rows[0]);
}

export async function restoreTenant(db: SqlExecutor, id: TenantId): Promise<Tenant> {
  const rows = await db.query<TenantRow>(
    `UPDATE tenancy.tenants SET state = 'active', archived_at = NULL WHERE id = $1
     RETURNING id, slug, name, state, created_at, archived_at`,
    [id],
  );
  if (rows.length === 0) throw new TenancyError({ code: 'unknown_tenant', ref: id });
  return toTenant(rows[0]);
}
