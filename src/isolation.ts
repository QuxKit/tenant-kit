// Isolation: making "whose rows" a property of the connection, not of every
// WHERE clause.
//
// The shared-schema strategy here pairs with `sql/002_rls.sql`. The contract:
//
//   1. `tenancy.protect(table)` (SQL) enables **forced** row-level security on
//      a host table and installs one policy comparing the table's tenant
//      column to `tenancy.current_tenant()`.
//   2. `tenancy.current_tenant()` reads the transaction-local setting
//      `tenancy.tenant_id`, which only `scopedExecutor` sets — via
//      `set_config(…, true)`, parameterized, transaction-scoped.
//
// The two together turn the classic multi-tenant bug — one forgotten
// `WHERE tenant_id = $1` among five hundred — from a data leak into an empty
// result set. FORCE matters: without it the table owner bypasses every
// policy, which is exactly the role most app connections and every test run
// under, and the isolation would be theater that passes review and fails in
// the one deployment that connects as owner.
//
// `SET LOCAL` (the `true` in set_config) rather than `SET` is equally
// non-negotiable: a plain SET outlives its transaction, and on a pooled
// connection the next borrower inherits the previous request's tenant. That
// bug class is why every query below runs inside a transaction even when the
// caller did not ask for one.

import { TenancyError } from './errors.ts';
import type { SqlExecutor, TenantId } from './types.ts';

/** The transaction-local GUC that RLS policies read. One name, both sides. */
export const TENANT_SETTING = 'tenancy.tenant_id';

/**
 * An executor whose every statement runs as `tenantId`.
 *
 * Single statements are wrapped in a transaction so the setting has a scope
 * to be local to; explicit transactions set it once after BEGIN, and the
 * executor handed to the callback runs raw on the already-scoped connection.
 * The tenant id itself travels as a bind parameter into `set_config`, never
 * into SQL text — a tenant id is caller-adjacent data and gets the same
 * injection discipline as any other string.
 *
 * A `transaction` opened *inside* a scoped transaction is a savepoint on the
 * same connection: the inner body's failure rolls back only the inner work,
 * and the scope — which belongs to the outer transaction — is untouched. The
 * savepoints are issued here, not delegated to the underlying executor's
 * nested `transaction`, because that contract does not promise savepoints
 * and this one does.
 */
export function scopedExecutor(db: SqlExecutor, tenantId: TenantId): SqlExecutor {
  if (tenantId.length === 0) throw new TenancyError({ code: 'no_tenant_context' });
  const enter = (tx: SqlExecutor) =>
    tx.query(`SELECT set_config('${TENANT_SETTING}', $1, true)`, [tenantId]);

  return {
    query: (text, params) =>
      db.transaction(async (tx) => {
        await enter(tx);
        return tx.query(text, params);
      }),
    transaction: (fn) =>
      db.transaction(async (tx) => {
        await enter(tx);
        return fn(nested(tx, 0));
      }),
  };
}

/**
 * The executor handed to a scoped transaction body: raw statements on the
 * already-scoped connection, and savepoint-backed nested transactions.
 * Savepoint names come from a depth counter, never from caller input.
 */
function nested(tx: SqlExecutor, depth: number): SqlExecutor {
  const scoped: SqlExecutor = {
    query: (text, params) => tx.query(text, params),
    transaction: async (inner) => {
      const name = `tenancy_scope_sp_${depth + 1}`;
      await tx.query(`SAVEPOINT ${name}`);
      try {
        const out = await inner(nested(tx, depth + 1));
        await tx.query(`RELEASE SAVEPOINT ${name}`);
        return out;
      } catch (error) {
        await tx.query(`ROLLBACK TO SAVEPOINT ${name}`);
        throw error;
      }
    },
  };
  return scoped;
}

/**
 * Database-per-tenant (or schema-per-tenant) routing: the other end of the
 * isolation spectrum, where a tenant's isolation is that its rows live
 * somewhere else entirely.
 *
 * The kit's contribution is deliberately small — memoized routing over a
 * function you write — because the hard parts (provisioning, migrations per
 * database, connection budgets) are operational choices this library would
 * only get wrong on your behalf. docs/ISOLATION.md weighs when this shape is
 * worth that operational bill.
 */
export function routedExecutor(
  route: (tenantId: TenantId) => SqlExecutor,
): (tenantId: TenantId) => SqlExecutor {
  const cache = new Map<TenantId, SqlExecutor>();
  return (tenantId) => {
    const hit = cache.get(tenantId);
    if (hit !== undefined) return hit;
    const db = route(tenantId);
    cache.set(tenantId, db);
    return db;
  };
}
