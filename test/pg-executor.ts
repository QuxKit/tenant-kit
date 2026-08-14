// A pg.Pool adapter for SqlExecutor, and the test harness that uses it.
//
// `fromPool` doubles as the proof of the design claim in src/types.ts: a bare
// pool satisfies the executor in about ten lines, and the same adapter serves
// billing-kit unchanged. If it ever stops being short, the interface has
// grown something it should not have.
//
// `pg` is a devDependency. tenant-kit itself has no runtime dependencies.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import type { SqlExecutor } from '../src/types';

export function fromPool(pool: pg.Pool): SqlExecutor {
  return {
    async query<T>(text: string, params?: readonly unknown[]): Promise<T[]> {
      const result = await pool.query(text, params as unknown[]);
      return result.rows as T[];
    },
    async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      // The body must run on one connection — doubly so here, where SET LOCAL
      // on the wrong connection is not a rollback bug but an isolation bug.
      const client = await pool.connect();
      const bound: SqlExecutor = {
        async query<R>(text: string, params?: readonly unknown[]): Promise<R[]> {
          const result = await client.query(text, params as unknown[]);
          return result.rows as R[];
        },
        transaction: (inner) => inner(bound),
      };
      try {
        await client.query('BEGIN');
        const out = await fn(bound);
        await client.query('COMMIT');
        return out;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

export const TEST_DATABASE_URL =
  process.env.TENANT_KIT_TEST_DATABASE_URL ?? 'postgres://localhost:5432/tenant_kit_test';

export interface Harness {
  db: SqlExecutor;
  pool: pg.Pool;
  close(): Promise<void>;
}

/**
 * Connect and rebuild the schema from the shipped sql/ files.
 *
 * Rebuilt per run rather than migrated, because the point of these tests is
 * that the shipped DDL produces the shipped behaviour. Dropping the schema
 * mid-run destroys a concurrent file's tables, which is why the test script
 * passes `--test-concurrency=1`.
 */
export async function setupDatabase(): Promise<Harness | null> {
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 4 });

  try {
    await pool.query('SELECT 1');
  } catch {
    await pool.end().catch(() => {});
    return null;
  }

  await pool.query('DROP SCHEMA IF EXISTS tenancy CASCADE');
  for (const file of ['001_core.sql', '002_rls.sql']) {
    const path = fileURLToPath(new URL(`../sql/${file}`, import.meta.url));
    await pool.query(await readFile(path, 'utf8'));
  }

  return {
    db: fromPool(pool),
    pool,
    close: async () => {
      await pool.end();
    },
  };
}

export const SKIP_REASON =
  `no database at ${TEST_DATABASE_URL} — set TENANT_KIT_TEST_DATABASE_URL or ` +
  `run: createdb tenant_kit_test`;

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
  await harness.pool.query(`DROP SCHEMA IF EXISTS host CASCADE`);
  await harness.pool.query(`CREATE SCHEMA host AUTHORIZATION ${APP_ROLE}`);
  await harness.pool.query(`GRANT USAGE ON SCHEMA tenancy TO ${APP_ROLE}`);

  const admin = new URL(TEST_DATABASE_URL);
  admin.username = APP_ROLE;
  admin.password = APP_ROLE;
  const pool = new pg.Pool({ connectionString: admin.toString(), max: 4 });
  try {
    await pool.query('SELECT 1');
  } catch {
    await pool.end().catch(() => {});
    return null;
  }
  return {
    db: fromPool(pool),
    pool,
    close: async () => {
      await pool.end();
    },
  };
}
