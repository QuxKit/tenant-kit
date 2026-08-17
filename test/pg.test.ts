// The shipped pg adapter, against a real Postgres: statements go through,
// transactions commit and roll back, and — the reason this file exists —
// a nested transaction() is a savepoint, so an inner failure the caller
// catches undoes only the inner work.

import assert from 'node:assert/strict';
import { before, it } from 'node:test';

import { scopedExecutor } from '../src/isolation.ts';
import { describeDb, setupDatabase } from './harness.ts';

const harness = await setupDatabase();

describeDb('pgExecutor', harness, ({ db }) => {
  before(async () => {
    await db.query('DROP TABLE IF EXISTS tenancy.pg_probe');
    await db.query('CREATE TABLE tenancy.pg_probe (k text PRIMARY KEY, tenant_id text)');
  });

  const keys = async () =>
    (await db.query<{ k: string }>('SELECT k FROM tenancy.pg_probe ORDER BY k')).map((r) => r.k);

  it('runs statements and returns rows', async () => {
    const rows = await db.query<{ n: number }>('SELECT $1::int AS n', [7]);
    assert.deepEqual(rows, [{ n: 7 }]);
  });

  it('commits a transaction, and rolls one back on throw', async () => {
    await db.transaction(async (tx) => {
      await tx.query(`INSERT INTO tenancy.pg_probe (k) VALUES ('committed')`);
    });
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.query(`INSERT INTO tenancy.pg_probe (k) VALUES ('rolled-back')`);
        throw new Error('abort');
      }),
      /abort/,
    );
    assert.deepEqual(await keys(), ['committed']);
  });

  it('a nested transaction is a savepoint: inner failure, outer survives', async () => {
    await db.transaction(async (tx) => {
      await tx.query(`INSERT INTO tenancy.pg_probe (k) VALUES ('outer')`);
      await assert.rejects(
        tx.transaction(async (inner) => {
          await inner.query(`INSERT INTO tenancy.pg_probe (k) VALUES ('inner')`);
          throw new Error('inner failed');
        }),
        /inner failed/,
      );
      // The outer transaction is still usable — it was not left aborted.
      await tx.query(`INSERT INTO tenancy.pg_probe (k) VALUES ('after')`);
    });
    assert.deepEqual(await keys(), ['after', 'committed', 'outer']);
  });

  it('nested savepoints release on success and stack by depth', async () => {
    await db.transaction(async (tx) => {
      await tx.transaction(async (l1) => {
        await l1.query(`INSERT INTO tenancy.pg_probe (k) VALUES ('l1')`);
        await assert.rejects(
          l1.transaction(async (l2) => {
            await l2.query(`INSERT INTO tenancy.pg_probe (k) VALUES ('l2')`);
            throw new Error('l2 failed');
          }),
        );
      });
    });
    const now = await keys();
    assert.ok(now.includes('l1'));
    assert.ok(!now.includes('l2'));
  });

  it('a scoped nested transaction rolls back its own work and keeps the scope', async () => {
    const scoped = scopedExecutor(db, 'tenant-z');
    const seen = await scoped.transaction(async (tx) => {
      await tx.query(`INSERT INTO tenancy.pg_probe (k, tenant_id) VALUES ('z-outer', 'tenant-z')`);
      await assert.rejects(
        tx.transaction(async (inner) => {
          await inner.query(`INSERT INTO tenancy.pg_probe (k) VALUES ('z-inner')`);
          throw new Error('inner failed');
        }),
        /inner failed/,
      );
      const rows = await tx.query<{ t: string }>('SELECT tenancy.current_tenant() AS t');
      return rows[0].t;
    });
    assert.equal(seen, 'tenant-z', 'the SET LOCAL belongs to the outer transaction');
    const now = await keys();
    assert.ok(now.includes('z-outer'));
    assert.ok(!now.includes('z-inner'));
  });
});
