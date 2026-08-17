// Physical isolation helpers: the two operations at the edges of a tenant's
// life that touch real DDL — giving a tenant its own schema, and erasing a
// tenant for good.
//
// Both are deliberately small. Provisioning strategy (which migrations, how
// they are versioned, which database) stays the host's; erasure *policy*
// (what counts as personal data, what must be retained) stays the host's.
// What the library owns is the part every host gets wrong alone: idempotent
// schema-plus-migrations bookkeeping, and an erasure that runs in one
// transaction, refuses an active tenant, and cannot forget the table that
// was added last month — because the table list is an argument the caller
// assembles next to `coverage()`, not a convention.
//
// Naming: `tenant_<slug>` with hyphens mapped to underscores. Slugs are DNS
// labels (lowercase alphanumerics and hyphens, ≤ 63 chars), so the mapped
// name is a valid unquoted identifier and cannot collide with another
// slug's mapping (hyphen is the only mapped character and underscores
// cannot appear in slugs).

import { TenancyError } from './errors.ts';
import { type MutationMeta, record } from './events.ts';
import { getTenant } from './tenants.ts';
import type { SqlExecutor, Tenant, TenantId } from './types.ts';

/** `acme-corp` → `tenant_acme_corp`. Exported so routing code can agree. */
export function tenantSchemaName(tenant: Pick<Tenant, 'slug'>): string {
  return `tenant_${tenant.slug.replaceAll('-', '_')}`;
}

export interface ProvisionSchemaOptions {
  /**
   * Migration SQL, applied in array order inside one transaction with
   * `search_path` set to the tenant's schema — write `CREATE TABLE projects
   * (…)`, not `CREATE TABLE tenant_acme.projects (…)`. Each entry is
   * applied once per schema, keyed by index, and recorded in
   * `<schema>.tenancy_migrations`; re-provisioning with a longer list
   * applies only the tail. Entries already applied must not be edited —
   * append instead — and the helper cannot tell if you do.
   */
  migrations: readonly string[];
}

export interface ProvisionedSchema {
  schema: string;
  /** Indexes of the migrations applied by this call. Empty on a no-op retry. */
  applied: number[];
}

/**
 * Create the tenant's schema (if absent) and bring it up to date with
 * `migrations`. Idempotent: calling again applies only what is new, and a
 * fully-provisioned schema is a no-op. Everything — CREATE SCHEMA, the
 * migrations, the bookkeeping — happens in one transaction, so a failing
 * migration leaves no half-provisioned schema behind.
 *
 * The tenant must exist (any state): provisioning an archived tenant's
 * schema is legitimate during a restore-then-migrate.
 */
export async function provisionSchema(
  db: SqlExecutor,
  tenantId: TenantId,
  options: ProvisionSchemaOptions,
  now: Date,
  meta?: MutationMeta,
): Promise<ProvisionedSchema> {
  const tenant = await getTenant(db, tenantId);
  const schema = tenantSchemaName(tenant);
  return db.transaction(async (tx) => {
    // Serialize provisioners of one schema; two concurrent calls otherwise
    // race CREATE TABLE IF NOT EXISTS inside the migrations themselves.
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`tenancy.provision:${schema}`]);
    await tx.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`);
    await tx.query(
      `CREATE TABLE IF NOT EXISTS ${quoteIdent(schema)}.tenancy_migrations (
         index      integer     PRIMARY KEY,
         applied_at timestamptz NOT NULL
       )`,
    );
    const done = await tx.query<{ index: number }>(
      `SELECT index FROM ${quoteIdent(schema)}.tenancy_migrations`,
    );
    const seen = new Set(done.map((r) => Number(r.index)));
    const applied: number[] = [];
    if (options.migrations.length > 0) {
      // Migrations run with the tenant schema first on the search_path, so
      // unqualified DDL lands there. Transaction-local, like the tenant GUC.
      await tx.query(`SELECT set_config('search_path', $1, true)`, [`${schema}, public`]);
      for (const [index, sql] of options.migrations.entries()) {
        if (seen.has(index)) continue;
        await tx.query(sql);
        await tx.query(
          `INSERT INTO ${quoteIdent(schema)}.tenancy_migrations (index, applied_at) VALUES ($1, $2)`,
          [index, now],
        );
        applied.push(index);
      }
    }
    if (applied.length > 0)
      await record(tx, {
        tenantId,
        type: 'schema_provisioned',
        payload: { schema, applied },
        target: schema,
        at: now,
        meta,
      });
    return { schema, applied };
  });
}

/**
 * Slugs produce valid identifiers already; quoting anyway means a future
 * relaxation of slug rules cannot become an injection. Doubling any `"` is
 * the whole of Postgres identifier escaping.
 */
function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export interface EraseTenantOptions {
  /**
   * Every shared-schema table holding this tenant's rows, as
   * `schema.table` or `table` names. Assemble it next to `coverage()` —
   * the same list of tenant-bearing tables, for the same reason — and pass
   * it explicitly: an erasure that guesses tables is one that misses one.
   */
  tables: readonly string[];
  /** The tenant column, when it is not `tenant_id`, per table or for all. */
  tenantColumn?: string | Record<string, string>;
  /** Also drop `tenant_<slug>` if it exists. Default true. */
  dropSchema?: boolean;
}

export interface ErasureReport {
  tenantId: TenantId;
  /** Rows deleted per table, in the order given. */
  deleted: Record<string, number>;
  /** The schema that was dropped, if one existed. */
  droppedSchema: string | null;
}

/**
 * Hard-delete a tenant: its rows in every registered table, its directory
 * rows (memberships, invitations, roles, unacked events), and — by default
 * — its `tenant_<slug>` schema. The tenants row itself survives as a
 * tombstone (still archived), because billing ledgers and audit logs
 * reference the id and an id that resolves to nothing cannot explain
 * itself; the audit log and acked events survive with it, recording that
 * the erasure happened.
 *
 * Refuses an active tenant with `tenant_not_archived`: archive first, so
 * erasure is always a two-step act and never a fat-fingered one call.
 * Everything runs in one transaction — a failure midway erases nothing.
 */
export async function eraseTenant(
  db: SqlExecutor,
  tenantId: TenantId,
  options: EraseTenantOptions,
  now: Date,
  meta?: MutationMeta,
): Promise<ErasureReport> {
  const tenant = await getTenant(db, tenantId);
  if (tenant.state !== 'archived')
    throw new TenancyError({ code: 'tenant_not_archived', tenantId });
  const schema = tenantSchemaName(tenant);

  return db.transaction(async (tx) => {
    const deleted: Record<string, number> = {};
    for (const table of options.tables) {
      const column =
        typeof options.tenantColumn === 'string'
          ? options.tenantColumn
          : (options.tenantColumn?.[table] ?? 'tenant_id');
      const rows = await tx.query<{ n: string }>(
        `WITH gone AS (
           DELETE FROM ${quoteQualified(table)} WHERE ${quoteIdent(column)} = $1 RETURNING 1
         ) SELECT count(*) AS n FROM gone`,
        [tenantId],
      );
      deleted[table] = Number(rows[0].n);
    }

    await tx.query(`DELETE FROM tenancy.invitations WHERE tenant_id = $1`, [tenantId]);
    await tx.query(`DELETE FROM tenancy.memberships WHERE tenant_id = $1`, [tenantId]);
    await tx.query(`DELETE FROM tenancy.roles WHERE tenant_id = $1`, [tenantId]);
    // Unacked events for an erased tenant would replay a life that no
    // longer exists; acked ones are history and stay.
    await tx.query(`DELETE FROM tenancy.events WHERE tenant_id = $1 AND acked_at IS NULL`, [
      tenantId,
    ]);

    let droppedSchema: string | null = null;
    if (options.dropSchema !== false) {
      const exists = await tx.query<{ ok: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS ok`,
        [schema],
      );
      if (exists[0].ok) {
        await tx.query(`DROP SCHEMA ${quoteIdent(schema)} CASCADE`);
        droppedSchema = schema;
      }
    }

    await record(tx, {
      tenantId,
      type: 'tenant_erased',
      payload: { deleted, droppedSchema },
      target: tenantId,
      at: now,
      meta,
    });
    return { tenantId, deleted, droppedSchema };
  });
}

/** `host.notes` → `"host"."notes"`; `notes` → `"notes"`. */
function quoteQualified(name: string): string {
  const parts = name.split('.');
  if (parts.length > 2 || parts.some((p) => p.length === 0))
    throw new TenancyError({
      code: 'invalid_tenant',
      field: 'tables',
      reason: `not a table name: ${JSON.stringify(name)}`,
    });
  return parts.map(quoteIdent).join('.');
}
