// RLS coverage, as the non-superuser app role: the report must see what the
// app's own connection sees, and the catalog reads must not need superuser.

import assert from 'node:assert/strict';
import { after, before, it } from 'node:test';

import { coverage } from '../src/coverage.ts';
import { createTenancy } from '../src/instance.ts';
import { describeDb, type Harness, setupAppRole, setupDatabase } from './harness.ts';

const admin = await setupDatabase();

describeDb('coverage', admin, (admin) => {
  let app: Harness;

  before(async () => {
    // Tables another test file leaves in public (physical.test.ts) would
    // otherwise show up in the report on the next run.
    await admin.pool.query('DROP TABLE IF EXISTS public.notes, public.files');
    const role = await setupAppRole(admin);
    if (role === null) throw new Error('the app role could not connect; see setupAppRole');
    app = role;
    await app.db.query(`
      CREATE TABLE host.projects  (id serial PRIMARY KEY, tenant_id text NOT NULL);
      CREATE TABLE host.documents (id serial PRIMARY KEY, org_id text NOT NULL);
      CREATE TABLE host.forgot    (id serial PRIMARY KEY, tenant_id text NOT NULL);
      CREATE TABLE host.halfway   (id serial PRIMARY KEY, tenant_id text NOT NULL);
      CREATE TABLE host.unforced  (id serial PRIMARY KEY, tenant_id text NOT NULL);
      CREATE TABLE host.nothing   (id serial PRIMARY KEY, name text);
      SELECT tenancy.protect('host.projects');
      SELECT tenancy.protect('host.documents', 'org_id');
      ALTER TABLE host.halfway ENABLE ROW LEVEL SECURITY;
      ALTER TABLE host.halfway FORCE ROW LEVEL SECURITY;
      ALTER TABLE host.unforced ENABLE ROW LEVEL SECURITY;
      CREATE POLICY p ON host.unforced USING (true);
    `);
  });
  after(async () => {
    await app?.close();
  });

  it('splits tenant-bearing tables by forced RLS + policy, with reasons', async () => {
    const report = await coverage(app.db);
    assert.deepEqual(
      report.protected.map((t) => t.table),
      ['host.projects'],
    );
    assert.deepEqual(
      report.unprotected.map((t) => [t.table, t.gaps]),
      [
        ['host.forgot', ['rls_disabled', 'rls_not_forced', 'no_policy']],
        ['host.halfway', ['no_policy']],
        ['host.unforced', ['rls_not_forced']],
      ],
    );
    const projects = report.protected[0];
    assert.equal(projects.schema, 'host');
    assert.equal(projects.name, 'projects');
    assert.equal(projects.column, 'tenant_id');
    assert.deepEqual(projects.policies, ['tenancy_isolation']);
    assert.equal(projects.rlsEnabled, true);
    assert.equal(projects.rlsForced, true);
    // The untenanted table and the tenancy.* directory are not in the report.
    const all = [...report.protected, ...report.unprotected].map((t) => t.table);
    assert.ok(!all.includes('host.nothing'));
    assert.ok(!all.some((t) => t.startsWith('tenancy.')));
  });

  it('honours other tenant column names and schema ignores', async () => {
    const report = await coverage(app.db, { columns: ['tenant_id', 'org_id'] });
    assert.deepEqual(
      report.protected.map((t) => [t.table, t.column]),
      [
        ['host.documents', 'org_id'],
        ['host.projects', 'tenant_id'],
      ],
    );
    const ignored = await coverage(app.db, { ignoreSchemas: ['host'] });
    assert.deepEqual(ignored, { protected: [], unprotected: [] });
  });

  it('is on the instance, and fixing the gap empties unprotected', async () => {
    const tenancy = createTenancy({ db: app.db });
    await app.db.query(`SELECT tenancy.protect('host.forgot')`);
    await app.db.query(`SELECT tenancy.protect('host.halfway')`);
    await app.db.query(`SELECT tenancy.protect('host.unforced')`);
    const report = await tenancy.coverage();
    assert.deepEqual(report.unprotected, []);
    assert.deepEqual(report.protected.map((t) => t.table).sort(), [
      'host.forgot',
      'host.halfway',
      'host.projects',
      'host.unforced',
    ]);
    // A table with two matching columns is reported once, on the first.
    await app.db.query(`
      CREATE TABLE host.both (id serial PRIMARY KEY, org_id text, tenant_id text)`);
    const both = await coverage(app.db, { columns: ['tenant_id', 'org_id'] });
    const entry = both.unprotected.find((t) => t.table === 'host.both');
    assert.equal(entry?.column, 'org_id');
    assert.equal(both.unprotected.filter((t) => t.table === 'host.both').length, 1);
  });
});
