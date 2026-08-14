// The tenants themselves: creation, lookup, rename, archive.
//
// Free functions taking `(db, …, now)`, same shape as billing-kit's core:
// configuration as an argument, never a module global, so two instances — a
// test on a rolled-back executor, a worker per region — coexist in one
// process. `instance.ts` binds the arguments once for call sites.

import { randomUUID } from 'node:crypto';
import { TenancyError } from './errors.ts';
import type { CreateTenantInput, SqlExecutor, Tenant, TenantId } from './types.ts';

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
 */
export async function createTenant(
  db: SqlExecutor,
  input: CreateTenantInput,
  now: Date,
  reserved?: ReadonlySet<string>,
): Promise<Tenant> {
  validateSlug(input.slug, reserved);
  if (input.name.trim().length === 0)
    throw new TenancyError({ code: 'invalid_tenant', field: 'name', reason: 'empty' });

  const id = input.id ?? randomUUID();
  const inserted = await db.query<TenantRow>(
    `INSERT INTO tenancy.tenants (id, slug, name, state, created_at)
     VALUES ($1, $2, $3, 'active', $4)
     ON CONFLICT (slug) DO NOTHING
     RETURNING id, slug, name, state, created_at, archived_at`,
    [id, input.slug, input.name, now],
  );
  if (inserted.length === 1) return toTenant(inserted[0]);

  const existing = await getTenantBySlug(db, input.slug);
  if (existing.name === input.name && existing.state === 'active') return existing;
  throw new TenancyError({
    code: 'slug_taken',
    slug: input.slug,
    detail:
      existing.state !== 'active'
        ? `existing tenant is ${existing.state}`
        : `existing tenant is named ${JSON.stringify(existing.name)}, not ${JSON.stringify(input.name)}`,
  });
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
