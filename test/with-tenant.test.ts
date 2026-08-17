// withTenant: one transaction, scoped once, many statements. Counted through
// a wrapping executor, and checked against the real SET LOCAL.

import assert from 'node:assert/strict';
import { it } from 'node:test';

import { createTenancy } from '../src/instance.ts';
import type { SqlExecutor } from '../src/types.ts';
import { describeDb, setupDatabase } from './harness.ts';

/** Counts BEGINs (transaction() calls) and statements on the base executor. */
function counting(db: SqlExecutor): SqlExecutor & { transactions: number; statements: number } {
  const counter = {
    transactions: 0,
    statements: 0,
    query: async <T>(text: string, params?: readonly unknown[]) => {
      counter.statements++;
      return db.query<T>(text, params);
    },
    transaction: <T>(fn: (tx: SqlExecutor) => Promise<T>) => {
      counter.transactions++;
      return db.transaction(fn);
    },
  };
  return counter;
}

const harness = await setupDatabase();

describeDb('withTenant', harness, ({ db }) => {
  it('runs many statements in one transaction with the scope set once', async () => {
    const counted = counting(db);
    const tenancy = createTenancy({ db: counted });
    const seen = await tenancy.withTenant('tenant-w', async (tx) => {
      const out: string[] = [];
      for (let i = 0; i < 3; i++) {
        const rows = await tx.query<{ t: string }>('SELECT tenancy.current_tenant() AS t');
        out.push(rows[0].t);
      }
      return out;
    });
    assert.deepEqual(seen, ['tenant-w', 'tenant-w', 'tenant-w']);
    assert.equal(counted.transactions, 1, 'one BEGIN for the whole callback');
    assert.equal(counted.statements, 0, 'nothing ran outside the transaction');
  });

  it('makes the tenant ambient for the callback, and rolls back on throw', async () => {
    const tenancy = createTenancy({ db });
    await db.query('CREATE TABLE IF NOT EXISTS tenancy.wt_probe (k text PRIMARY KEY)');
    assert.equal(tenancy.current(), null);
    await assert.rejects(
      tenancy.withTenant('tenant-w', async (tx) => {
        assert.equal(tenancy.require().tenantId, 'tenant-w');
        await tx.query(`INSERT INTO tenancy.wt_probe (k) VALUES ('doomed')`);
        throw new Error('handler failed');
      }),
      /handler failed/,
    );
    assert.equal(tenancy.current(), null);
    assert.deepEqual(await db.query('SELECT k FROM tenancy.wt_probe'), []);
  });

  it('accepts a ResolvedTenant and exposes it as the context', async () => {
    const tenancy = createTenancy({ db });
    const tenant = await tenancy.createTenant({ slug: 'wt', name: 'WT', owner: 'u-1' });
    const resolved = await tenancy.authorize({ tenantId: tenant.id, via: 'test' }, 'u-1');
    const ctx = await tenancy.withTenant(resolved, async (tx) => {
      const rows = await tx.query<{ t: string }>('SELECT tenancy.current_tenant() AS t');
      assert.equal(rows[0].t, tenant.id);
      return tenancy.require();
    });
    assert.equal(ctx.tenant?.slug, 'wt');
    assert.equal(ctx.membership?.role, 'owner');
  });

  it('nested transaction() inside withTenant is a savepoint', async () => {
    const tenancy = createTenancy({ db });
    await tenancy.withTenant('tenant-w', async (tx) => {
      await tx.query(`INSERT INTO tenancy.wt_probe (k) VALUES ('kept')`);
      await assert.rejects(
        tx.transaction(async (inner) => {
          await inner.query(`INSERT INTO tenancy.wt_probe (k) VALUES ('dropped')`);
          throw new Error('inner');
        }),
      );
    });
    const rows = await db.query<{ k: string }>('SELECT k FROM tenancy.wt_probe');
    assert.deepEqual(
      rows.map((r) => r.k),
      ['kept'],
    );
  });
});
