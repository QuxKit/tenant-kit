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
// the queries run unscoped on another.

import type { Pool, PoolClient } from 'pg';

import type { SqlExecutor } from './types.ts';

/** The subset of `pg.Pool` this adapter uses; a `pg.Pool` satisfies it directly. */
export type PgPoolLike = Pick<Pool, 'query' | 'connect'>;

/** The subset of `pg.PoolClient` used inside a transaction. */
type PgClientLike = Pick<PoolClient, 'query' | 'release'>;

function boundTo(client: PgClientLike): SqlExecutor {
  const bound: SqlExecutor = {
    async query<R>(text: string, params?: readonly unknown[]): Promise<R[]> {
      const result = await client.query(text, params as unknown[]);
      return result.rows as R[];
    },
    transaction: (inner) => inner(bound),
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
