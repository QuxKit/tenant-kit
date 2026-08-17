// Physical isolation helpers: idempotent schema provisioning with migration
// bookkeeping, and erasure that refuses active tenants, deletes across the
// registered tables in one transaction, and leaves a tombstone + audit.

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { TenancyError } from '../src/errors.ts';
import { createTenancy } from '../src/instance.ts';
import { tenantSchemaName } from '../src/physical.ts';
import { describeDb, setupDatabase } from './harness.ts';

const NOW = new Date('2026-08-16T15:00:00Z');

describe('tenantSchemaName', () => {
  it('maps hyphens to underscores and cannot collide', () => {
    assert.equal(tenantSchemaName({ slug: 'acme' }), 'tenant_acme');
    assert.equal(tenantSchemaName({ slug: 'acme-corp' }), 'tenant_acme_corp');
  });
});

const harness = await setupDatabase();

describeDb('physical isolation', harness, ({ db, pool }) => {
  const tenancy = createTenancy({ db, clock: () => NOW });
  let acmeId: string;

  const drain = async () => {
    const events = await tenancy.events.poll({ limit: 1000 });
    await tenancy.events.ack(events.map((e) => e.id));
    return events;
  };

  before(async () => {
    // The harness rebuilds tenancy.*; this file's own artifacts outlive a
    // run (they live in public and tenant_* schemas), so clear them here.
    for (const schema of [
      'tenant_acme_corp',
      'tenant_atomic',
      'tenant_paused',
      'tenant_keeper',
      'tenant_bare',
    ])
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.query('DROP TABLE IF EXISTS public.notes, public.files');
    acmeId = (await tenancy.createTenant({ slug: 'acme-corp', name: 'Acme', owner: 'o-1' })).id;
    await drain();
  });

  it('provisions a schema, applies migrations once, and applies only the tail later', async () => {
    const migrations = [
      `CREATE TABLE projects (id serial PRIMARY KEY, name text NOT NULL)`,
      `ALTER TABLE projects ADD COLUMN done boolean NOT NULL DEFAULT false`,
    ];
    const first = await tenancy.provisionSchema(acmeId, { migrations });
    assert.deepEqual(first, { schema: 'tenant_acme_corp', applied: [0, 1] });

    // Unqualified DDL landed in the tenant schema, not public.
    await db.query(`INSERT INTO tenant_acme_corp.projects (name) VALUES ('p1')`);
    const inPublic = await db.query<{ ok: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'projects') AS ok`,
    );
    assert.equal(inPublic[0].ok, false);

    // Retry: no-op, no event.
    await drain();
    const again = await tenancy.provisionSchema(acmeId, { migrations });
    assert.deepEqual(again.applied, []);
    assert.deepEqual(await tenancy.events.poll(), []);

    // A longer list applies only the new tail.
    const extended = await tenancy.provisionSchema(acmeId, {
      migrations: [...migrations, `CREATE INDEX projects_by_name ON projects (name)`],
    });
    assert.deepEqual(extended.applied, [2]);
    const events = await drain();
    assert.deepEqual(
      events.map((e) => [e.type, e.payload]),
      [['schema_provisioned', { schema: 'tenant_acme_corp', applied: [2] }]],
    );
  });

  it('a failing migration provisions nothing', async () => {
    const gone = await tenancy.createTenant({ slug: 'atomic', name: 'Atomic', owner: 'o-1' });
    await assert.rejects(
      tenancy.provisionSchema(gone.id, {
        migrations: [`CREATE TABLE ok (id int)`, `THIS IS NOT SQL`],
      }),
      /syntax error/,
    );
    const exists = await db.query<{ ok: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'tenant_atomic') AS ok`,
    );
    assert.equal(exists[0].ok, false, 'CREATE SCHEMA rolled back with the failed migration');
    await drain();
  });

  it('unknown tenants are refused; provisioning an archived tenant is allowed', async () => {
    await assert.rejects(tenancy.provisionSchema('nope', { migrations: [] }), (e: unknown) =>
      TenancyError.hasCode(e, 'unknown_tenant'),
    );
    const paused = await tenancy.createTenant({ slug: 'paused', name: 'P', owner: 'o-1' });
    await tenancy.archiveTenant(paused.id);
    const out = await tenancy.provisionSchema(paused.id, {
      migrations: [`CREATE TABLE t (id int)`],
    });
    assert.deepEqual(out.applied, [0]);
    await drain();
  });

  it('erase refuses an active tenant, then erases an archived one completely', async () => {
    // Shared-schema data for the tenant, plus a bystander tenant's rows.
    await db.query(`CREATE TABLE IF NOT EXISTS public.notes (
      id serial PRIMARY KEY, tenant_id text NOT NULL, body text)`);
    await db.query(`CREATE TABLE IF NOT EXISTS public.files (
      id serial PRIMARY KEY, org_id text NOT NULL, path text)`);
    await db.query(`INSERT INTO public.notes (tenant_id, body) VALUES ($1, 'a'), ($1, 'b')`, [
      acmeId,
    ]);
    await db.query(`INSERT INTO public.notes (tenant_id, body) VALUES ('bystander', 'keep')`);
    await db.query(`INSERT INTO public.files (org_id, path) VALUES ($1, '/x')`, [acmeId]);
    await tenancy.addMember({ tenantId: acmeId, userId: 'm-2', role: 'member' });
    await tenancy.roles.define({ tenantId: acmeId, name: 'viewer', permissions: ['x:read'] });
    await tenancy.invitations.invite({
      tenantId: acmeId,
      email: 'late@example.com',
      role: 'member',
      invitedBy: 'o-1',
    });

    const options = {
      tables: ['public.notes', 'public.files'],
      tenantColumn: { 'public.files': 'org_id' },
    };
    await assert.rejects(tenancy.eraseTenant(acmeId, options), (e: unknown) =>
      TenancyError.hasCode(e, 'tenant_not_archived'),
    );

    await tenancy.archiveTenant(acmeId);
    const unackedBefore = await tenancy.events.poll({ limit: 1000 });
    assert.ok(unackedBefore.length > 0, 'there are unacked events to be discarded');

    const report = await tenancy.as('gdpr-bot').eraseTenant(acmeId, options);
    assert.deepEqual(report, {
      tenantId: acmeId,
      deleted: { 'public.notes': 2, 'public.files': 1 },
      droppedSchema: 'tenant_acme_corp',
    });

    // Shared rows: only the tenant's are gone.
    const notes = await db.query<{ tenant_id: string }>('SELECT tenant_id FROM public.notes');
    assert.deepEqual(
      notes.map((r) => r.tenant_id),
      ['bystander'],
    );
    // Directory rows gone; tombstone remains, archived.
    assert.deepEqual(await tenancy.listMembers(acmeId), []);
    assert.deepEqual(await tenancy.invitations.list(acmeId), []);
    assert.equal((await tenancy.roles.list(acmeId)).length, 3, 'built-ins only');
    const tombstone = await tenancy.getTenant(acmeId);
    assert.equal(tombstone.state, 'archived');
    // Schema dropped.
    const schema = await db.query<{ ok: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'tenant_acme_corp') AS ok`,
    );
    assert.equal(schema[0].ok, false);
    // Unacked events discarded; the erasure event is the only unacked one left.
    const unacked = await tenancy.events.poll({ limit: 1000 });
    const forAcme = unacked.filter((e) => e.tenantId === acmeId);
    assert.deepEqual(
      forAcme.map((e) => e.type),
      ['tenant_erased'],
    );
    assert.deepEqual(forAcme[0].payload.deleted, { 'public.notes': 2, 'public.files': 1 });
    // The audit trail survives and records the erasure with its actor.
    const audit = await tenancy.audit.list(acmeId, { limit: 1 });
    assert.equal(audit[0].action, 'tenant_erased');
    assert.equal(audit[0].actor, 'gdpr-bot');

    // Idempotent-ish: a second erasure deletes zero rows and drops nothing.
    const again = await tenancy.as('gdpr-bot').eraseTenant(acmeId, options);
    assert.deepEqual(again.deleted, { 'public.notes': 0, 'public.files': 0 });
    assert.equal(again.droppedSchema, null);
  });

  it('erasure is one transaction: a bad table midway erases nothing', async () => {
    const t = await tenancy.createTenant({ slug: 'halfway', name: 'H', owner: 'o-1' });
    await db.query(`INSERT INTO public.notes (tenant_id, body) VALUES ($1, 'still here')`, [t.id]);
    await tenancy.archiveTenant(t.id);
    await assert.rejects(
      tenancy.eraseTenant(t.id, { tables: ['public.notes', 'public.does_not_exist'] }),
      /does_not_exist/,
    );
    const rows = await db.query(`SELECT 1 FROM public.notes WHERE tenant_id = $1`, [t.id]);
    assert.equal(rows.length, 1, 'nothing was deleted');
    assert.equal((await tenancy.listMembers(t.id)).length, 1);
    // And a malformed table name is a typed refusal, not SQL.
    await assert.rejects(
      tenancy.eraseTenant(t.id, { tables: ['a.b.c'] }),
      (e: unknown) => TenancyError.hasCode(e, 'invalid_tenant') && e.failure.field === 'tables',
    );
    await assert.rejects(tenancy.eraseTenant('nope', { tables: [] }), (e: unknown) =>
      TenancyError.hasCode(e, 'unknown_tenant'),
    );
  });

  it('dropSchema: false leaves the schema; a schemaless tenant erases fine', async () => {
    const t = await tenancy.createTenant({ slug: 'keeper', name: 'K', owner: 'o-1' });
    await tenancy.provisionSchema(t.id, { migrations: [`CREATE TABLE t (id int)`] });
    await tenancy.archiveTenant(t.id);
    const kept = await tenancy.eraseTenant(t.id, { tables: [], dropSchema: false });
    assert.equal(kept.droppedSchema, null);
    const exists = await db.query<{ ok: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'tenant_keeper') AS ok`,
    );
    assert.equal(exists[0].ok, true);

    const bare = await tenancy.createTenant({ slug: 'bare', name: 'B', owner: 'o-1' });
    await tenancy.archiveTenant(bare.id);
    const out = await tenancy.eraseTenant(bare.id, { tables: [] });
    assert.equal(out.droppedSchema, null);
  });
});
