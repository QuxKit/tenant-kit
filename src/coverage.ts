// RLS coverage: which tenant-bearing tables are actually isolated.
//
// `tenancy.protect()` is opt-in per table, which is right — the library
// cannot know which of your tables are tenant-scoped — and also the weak
// point: the guarantee is only as strong as the list of tables someone
// remembered. A migration that adds `tenant_id` and forgets the `protect()`
// call is unprotected until an incident says so.
//
// `coverage` closes that loop from the catalog side. It walks `pg_class`
// for every table outside `tenancy.*` (and the system schemas) that has a
// tenant column, and reports whether row-level security is enabled,
// *forced*, and carries at least one policy. All three, or the table is
// unprotected — with the reason, so the fix is one line and not a search.
// Run it as a startup assertion or a CI step; the shape is made for
// `assert.deepEqual(unprotected, [])`.
//
// The catalog tables it reads (`pg_class`, `pg_namespace`, `pg_attribute`,
// `pg_policy`) are readable by every role, so this works as the ordinary
// app role — which is also the role whose view of the tables matters.

import type { SqlExecutor } from './types.ts';

export type CoverageGap = 'rls_disabled' | 'rls_not_forced' | 'no_policy';

export interface TableCoverage {
  /** `schema.table`, as `regclass` would print it. */
  table: string;
  schema: string;
  name: string;
  /** Which tenant column it was matched on. */
  column: string;
  rlsEnabled: boolean;
  rlsForced: boolean;
  policies: string[];
  /** Empty when protected; otherwise every reason, in severity order. */
  gaps: CoverageGap[];
}

export interface CoverageReport {
  protected: TableCoverage[];
  unprotected: TableCoverage[];
}

export interface CoverageOptions {
  /** Column names that mark a table as tenant-scoped. Default `['tenant_id']`. */
  columns?: readonly string[];
  /** Schemas to leave out, on top of `tenancy` and the system schemas. */
  ignoreSchemas?: readonly string[];
}

interface CoverageRow {
  schema: string;
  name: string;
  column: string;
  rls_enabled: boolean;
  rls_forced: boolean;
  policies: string[];
}

const ALWAYS_IGNORED = ['tenancy', 'pg_catalog', 'information_schema'];

/**
 * Every table with a tenant column, split by whether forced RLS with at
 * least one policy is in place. `tenancy.*` is excluded by design — the
 * directory tables are read before any scope exists and are documented as
 * unpolicied.
 */
export async function coverage(
  db: SqlExecutor,
  options: CoverageOptions = {},
): Promise<CoverageReport> {
  const columns = options.columns ?? ['tenant_id'];
  const ignored = [...ALWAYS_IGNORED, ...(options.ignoreSchemas ?? [])];
  const rows = await db.query<CoverageRow>(
    `SELECT n.nspname                 AS schema,
            c.relname                 AS name,
            a.attname                 AS column,
            c.relrowsecurity          AS rls_enabled,
            c.relforcerowsecurity     AS rls_forced,
            COALESCE(
              (SELECT array_agg(p.polname ORDER BY p.polname)
                 FROM pg_policy p WHERE p.polrelid = c.oid),
              '{}'::name[]
            )::text[]                 AS policies
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid
                          AND a.attnum > 0
                          AND NOT a.attisdropped
                          AND a.attname = ANY($1::name[])
      WHERE c.relkind IN ('r', 'p')
        AND n.nspname <> ALL($2::name[])
        AND n.nspname NOT LIKE 'pg\\_toast%'
        AND n.nspname NOT LIKE 'pg\\_temp%'
      ORDER BY n.nspname, c.relname, a.attnum`,
    [columns, ignored],
  );

  const report: CoverageReport = { protected: [], unprotected: [] };
  const seen = new Set<string>();
  for (const row of rows) {
    const table = `${row.schema}.${row.name}`;
    // A table with two matching columns (say tenant_id and org_id) is one
    // table; the first column in attnum order names it.
    if (seen.has(table)) continue;
    seen.add(table);
    const gaps: CoverageGap[] = [];
    if (!row.rls_enabled) gaps.push('rls_disabled');
    if (!row.rls_forced) gaps.push('rls_not_forced');
    if (row.policies.length === 0) gaps.push('no_policy');
    const entry: TableCoverage = {
      table,
      schema: row.schema,
      name: row.name,
      column: row.column,
      rlsEnabled: row.rls_enabled,
      rlsForced: row.rls_forced,
      policies: row.policies,
      gaps,
    };
    (gaps.length === 0 ? report.protected : report.unprotected).push(entry);
  }
  return report;
}
