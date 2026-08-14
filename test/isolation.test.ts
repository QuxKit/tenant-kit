// Row-level security tests — the claims the whole shared-schema strategy
// rests on, exercised against a real Postgres as a real (non-super) user.
//
// Superusers bypass RLS no matter what FORCE says, and a dev cluster's
// default account is usually a superuser, so these tests run on a dedicated
// LOGIN role that also *owns* the host tables. Owning matters: it is the
// case FORCE exists for, and the case an app connection string usually is.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { scopedExecutor } from '../src/isolation';
import { SKIP_REASON, setupAppRole, setupDatabase, type Harness } from './pg-executor';

describe('row-level security', () => {
  let admin: Harness | null = null;
  let app: Harness | null = null;

  before(async () => {
    admin = await setupDatabase();
    if (admin === null) return;
    app = await setupAppRole(admin);
    if (app === null) return;

    // The app role builds its own tables — text tenant column matching
    // billing-kit's shape, and a uuid one to prove the policy casts on the
    // function side rather than breaking on typed columns.
    await app.db.query(`
      CREATE TABLE host.projects (
        id        serial PRIMARY KEY,
        tenant_id text NOT NULL,
        name      text NOT NULL
      )`);
    await app.db.query(`
      CREATE TABLE host.typed (
        id        serial PRIMARY KEY,
        tenant_id uuid NOT NULL
      )`);
    await app.db.query(`SELECT tenancy.protect('host.projects')`);
    await app.db.query(`SELECT tenancy.protect('host.typed')`);

    const a = scopedExecutor(app.db, 'tenant-a');
    const b = scopedExecutor(app.db, 'tenant-b');
    await a.query(`INSERT INTO host.projects (tenant_id, name) VALUES ('tenant-a', 'alpha')`);
    await a.query(`INSERT INTO host.projects (tenant_id, name) VALUES ('tenant-a', 'apex')`);
    await b.query(`INSERT INTO host.projects (tenant_id, name) VALUES ('tenant-b', 'beta')`);
  });
  after(async () => {
    await app?.close();
    await admin?.close();
  });

  const ready = () => admin !== null && app !== null;

  it('a scoped executor sees its tenant’s rows and no one else’s', async (t) => {
    if (!ready()) return t.skip(SKIP_REASON);
    const a = scopedExecutor(app!.db, 'tenant-a');
    const b = scopedExecutor(app!.db, 'tenant-b');
    const aRows = await a.query<{ name: string }>(`SELECT name FROM host.projects ORDER BY name`);
    const bRows = await b.query<{ name: string }>(`SELECT name FROM host.projects`);
    assert.deepEqual(aRows.map((r) => r.name), ['alpha', 'apex']);
    assert.deepEqual(bRows.map((r) => r.name), ['beta']);
  });

  it('an unscoped connection sees an empty table, not an error — even as the owner', async (t) => {
    if (!ready()) return t.skip(SKIP_REASON);
    const rows = await app!.db.query(`SELECT * FROM host.projects`);
    assert.deepEqual(rows, [], 'FORCE row level security applies to the table owner');
  });

  it('a scoped write for another tenant is rejected by WITH CHECK', async (t) => {
    if (!ready()) return t.skip(SKIP_REASON);
    const a = scopedExecutor(app!.db, 'tenant-a');
    await assert.rejects(
      a.query(`INSERT INTO host.projects (tenant_id, name) VALUES ('tenant-b', 'smuggled')`),
      (e: unknown) => (e as { code?: string }).code === '42501',
      'writing a row the policy would hide from you is an error, not a quiet success',
    );
  });

  it('an UPDATE cannot move a row across the boundary', async (t) => {
    if (!ready()) return t.skip(SKIP_REASON);
    const a = scopedExecutor(app!.db, 'tenant-a');
    await assert.rejects(
      a.query(`UPDATE host.projects SET tenant_id = 'tenant-b' WHERE name = 'alpha'`),
      (e: unknown) => (e as { code?: string }).code === '42501',
    );
  });

  it('the scope does not leak to the connection’s next borrower', async (t) => {
    if (!ready()) return t.skip(SKIP_REASON);
    const a = scopedExecutor(app!.db, 'tenant-a');
    await a.query(`SELECT 1`); // takes and returns a pooled connection, scoped
    const afterwards = await app!.db.query(`SELECT * FROM host.projects`);
    assert.deepEqual(afterwards, [], 'SET LOCAL died with its transaction');
  });

  it('scoped transactions stay scoped across their statements', async (t) => {
    if (!ready()) return t.skip(SKIP_REASON);
    const a = scopedExecutor(app!.db, 'tenant-a');
    const count = await a.transaction(async (tx) => {
      await tx.query(`INSERT INTO host.projects (tenant_id, name) VALUES ('tenant-a', 'atlas')`);
      const rows = await tx.query<{ n: string }>(`SELECT count(*) AS n FROM host.projects`);
      return Number(rows[0].n);
    });
    assert.equal(count, 3, 'sees its own insert plus its own two rows, nobody else’s');
  });

  it('protects uuid tenant columns by casting the function, not the column', async (t) => {
    if (!ready()) return t.skip(SKIP_REASON);
    const id = '6b8f0f0e-8a1a-4b7e-9b6e-3f2a1c9d0e5f';
    const scoped = scopedExecutor(app!.db, id);
    await scoped.query(`INSERT INTO host.typed (tenant_id) VALUES ($1)`, [id]);
    const rows = await scoped.query(`SELECT id FROM host.typed`);
    assert.equal(rows.length, 1);
    const other = scopedExecutor(app!.db, '00000000-0000-0000-0000-000000000000');
    assert.deepEqual(await other.query(`SELECT id FROM host.typed`), []);
  });

  it('protect refuses a table with no tenant column, by name', async (t) => {
    if (!ready()) return t.skip(SKIP_REASON);
    await app!.db.query(`CREATE TABLE host.untenanted (id serial PRIMARY KEY)`);
    await assert.rejects(
      app!.db.query(`SELECT tenancy.protect('host.untenanted')`),
      (e: unknown) => String((e as Error).message).includes('has no column'),
    );
  });
});
