// The shipped `pg` adapter: a `pg.Pool` as a `SqlExecutor`.
//
// This file is the proof of the design claim in types.ts — a bare pool
// satisfies the executor in a few dozen lines, and the same adapter serves
// billing-kit unchanged. It lives behind the `./pg` subpath so that the root
// entry keeps its zero-dependency promise: `pg` is an *optional* peer, only
// resolved when you import `@quxkit/tenant-kit/pg`.
//
// `transaction` pins the body to one connection. That matters more here than
// in most libraries: `SET LOCAL` on the wrong connection is not a rollback
// bug but an isolation bug — the tenant scope lands on one connection while
// the queries run unscoped on another. Nested `transaction` calls become
// savepoints, so a caught inner failure does not poison the outer one.

import type { Pool, PoolClient } from 'pg';

import type { SqlExecutor } from './types.ts';

/** The subset of `pg.Pool` this adapter uses; a `pg.Pool` satisfies it directly. */
export type PgPoolLike = Pick<Pool, 'query' | 'connect'>;

/** The subset of `pg.PoolClient` used inside a transaction. */
type PgClientLike = Pick<PoolClient, 'query' | 'release'>;

/**
 * A `SqlExecutor` bound to one checked-out client. `transaction` here is a
 * *nested* transaction: it opens a savepoint, runs the body, and releases or
 * rolls back to that savepoint — so an inner failure undoes only the inner
 * work and the outer transaction carries on. Flattening (running the inner
 * body on the same connection with no savepoint) would make "the inner call
 * failed but I caught it" leave the outer transaction in an aborted state.
 *
 * Savepoint names are generated from a depth counter, never from caller
 * input, so they cannot carry anything into the SQL text.
 */
function boundTo(client: PgClientLike, depth = 0): SqlExecutor {
  const bound: SqlExecutor = {
    async query<R>(text: string, params?: readonly unknown[]): Promise<R[]> {
      const result = await client.query(text, params as unknown[]);
      return result.rows as R[];
    },
    async transaction<T>(inner: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      const name = `tenancy_sp_${depth + 1}`;
      await client.query(`SAVEPOINT ${name}`);
      try {
        const out = await inner(boundTo(client, depth + 1));
        await client.query(`RELEASE SAVEPOINT ${name}`);
        return out;
      } catch (error) {
        await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
        throw error;
      }
    },
  };
  return bound;
}

/**
 * Wrap a `pg.Pool` as a `SqlExecutor`.
 *
 * Single statements go straight to the pool. `transaction` checks a client
 * out, runs BEGIN, the body, and COMMIT (ROLLBACK on throw), and releases the
 * client whatever happens.
 */
export function pgExecutor(pool: PgPoolLike): SqlExecutor {
  return {
    async query<T>(text: string, params?: readonly unknown[]): Promise<T[]> {
      const result = await pool.query(text, params as unknown[]);
      return result.rows as T[];
    },
    async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(boundTo(client));
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
