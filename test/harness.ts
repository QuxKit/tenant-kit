// The shared test harness: one place that connects, rebuilds the shipped
// schema, and decides what happens when there is no database.
//
// Every DB-backed test file does the same three things — `await
// setupDatabase()` at module load, `describeDb(...)` around its suite, and
// nothing else — so the skip/require decision is made here exactly once:
//
//   - locally, with no Postgres at TEST_DATABASE_URL, DB suites are *skipped*
//     with a reason that says how to fix it;
//   - with `REQUIRE_DB` set (CI does this), an unreachable database is an
//     error, because a green run made of skips is the worst kind of green.
//
// The pool adapter is the shipped one (`src/pg.ts`), not a private copy — the
// tests exercise the adapter the README tells you to import.

import { readFile } from 'node:fs/promises';
import { after, describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { pgExecutor } from '../src/pg.ts';
import type { SqlExecutor } from '../src/types.ts';

export const TEST_DATABASE_URL =
  process.env.TENANT_KIT_TEST_DATABASE_URL ?? 'postgres://localhost:5432/tenant_kit_test';

/** `REQUIRE_DB=1` (anything but empty/`0`) turns "no database" from a skip into a failure. */
export const REQUIRE_DB = (() => {
  const v = process.env.REQUIRE_DB;
  return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
})();

export const SKIP_REASON =
  `no database at ${TEST_DATABASE_URL} — set TENANT_KIT_TEST_DATABASE_URL or ` +
  'run: createdb tenant_kit_test';

/** Every shipped migration, in order. Add new files here as they land. */
export const SQL_FILES = [
  '001_core.sql',
  '002_rls.sql',
  '003_invitations.sql',
  '004_roles.sql',
  '005_events.sql',
];

export interface Harness {
  db: SqlExecutor;
  pool: pg.Pool;
  close(): Promise<void>;
}

async function tryConnect(connectionString: string): Promise<pg.Pool | null> {
  const pool = new pg.Pool({ connectionString, max: 4 });
  try {
    await pool.query('SELECT 1');
    return pool;
  } catch (error) {
    await pool.end().catch(() => {});
    if (REQUIRE_DB) {
      const why = error as { code?: string; message?: string };
      throw new Error(
        `REQUIRE_DB is set but no database is reachable at ${connectionString} ` +
          `(${why.code ?? why.message ?? String(error)})`,
        { cause: error },
      );
    }
    return null;
  }
}

/**
 * Connect and rebuild the schema from the shipped sql/ files.
 *
 * Rebuilt per run rather than migrated, because the point of these tests is
 * that the shipped DDL produces the shipped behaviour. Dropping the schema
 * mid-run destroys a concurrent file's tables, which is why the test script
 * passes `--test-concurrency=1`.
 *
 * Returns null (or throws, under REQUIRE_DB) when there is no database.
 */
export async function setupDatabase(): Promise<Harness | null> {
  const pool = await tryConnect(TEST_DATABASE_URL);
  if (pool === null) return null;

  await pool.query('DROP SCHEMA IF EXISTS tenancy CASCADE');
  for (const file of SQL_FILES) {
    const path = fileURLToPath(new URL(`../sql/${file}`, import.meta.url));
    await pool.query(await readFile(path, 'utf8'));
  }

  return {
    db: pgExecutor(pool),
    pool,
    close: async () => {
      await pool.end();
    },
  };
}

/**
 * The isolation tests cannot run as a superuser: Postgres exempts superusers
 * (and BYPASSRLS roles) from every policy, FORCE or not, and a local dev
 * cluster's default account is usually exactly that. So the harness makes a
 * plain LOGIN role and a schema it owns; the RLS tests connect as the role,
 * create their host tables as it, and are therefore genuinely subject to the
 * policies — including FORCE, since the role owns what it queries.
 */
export const APP_ROLE = 'tenant_kit_test_app';

export async function setupAppRole(harness: Harness): Promise<Harness | null> {
  await harness.pool.query(`
    DO $$ BEGIN
      CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_ROLE}';
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
  await harness.pool.query('DROP SCHEMA IF EXISTS host CASCADE');
  await harness.pool.query(`CREATE SCHEMA host AUTHORIZATION ${APP_ROLE}`);
  await harness.pool.query(`GRANT USAGE ON SCHEMA tenancy TO ${APP_ROLE}`);

  const url = new URL(TEST_DATABASE_URL);
  url.username = APP_ROLE;
  url.password = APP_ROLE;
  const pool = await tryConnect(url.toString());
  if (pool === null) return null;
  return {
    db: pgExecutor(pool),
    pool,
    close: async () => {
      await pool.end();
    },
  };
}

/**
 * A `describe` that only exists when there is a database. Skipped, with
 * `SKIP_REASON`, when `harness` is null; otherwise the suite runs with the
 * harness and closes it afterwards. Test files call `setupDatabase()` at
 * module load (top-level await) and hand the result here — so no test body
 * ever checks for the database itself.
 */
export function describeDb(
  name: string,
  harness: Harness | null,
  body: (harness: Harness) => void,
): void {
  if (harness === null) {
    describe(name, { skip: SKIP_REASON }, () => {});
    return;
  }
  describe(name, () => {
    after(() => harness.close());
    body(harness);
  });
}
