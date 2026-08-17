// Tenant directory tests, against a real Postgres. The interesting behaviour
// is in `ON CONFLICT DO NOTHING` under the unique slug constraint and in the
// state checks the DDL enforces — a mock would only certify our own SQL text.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TenancyError } from '../src/errors.ts';
import { createTenancy } from '../src/instance.ts';
import { fromSubdomain } from '../src/resolve.ts';
import { validateSlug } from '../src/tenants.ts';
import { describeDb, setupDatabase } from './harness.ts';

const NOW = new Date('2026-08-14T12:00:00Z');

describe('validateSlug', () => {
  it('names the reason, not just "invalid"', () => {
    for (const [slug, reason] of [
      ['', 'empty'],
      ['Acme', 'lowercase'],
      ['acme_corp', 'lowercase'],
      ['-acme', 'lowercase'],
      ['acme--corp', 'lowercase'],
      ['a'.repeat(64), 'DNS label'],
      ['www', 'reserved'],
    ] as const) {
      assert.throws(
        () => validateSlug(slug),
        (e: unknown) =>
          TenancyError.hasCode(e, 'invalid_slug') && e.failure.reason.includes(reason.slice(0, 5)),
        `slug ${JSON.stringify(slug)}`,
      );
    }
    assert.doesNotThrow(() => validateSlug('acme-corp-2'));
  });
});

const harness = await setupDatabase();

describeDb('tenants', harness, ({ db }) => {
  const tenancy = createTenancy({ db, clock: () => NOW });

  it('creates, and creating again with identical input is the same tenant', async () => {
    const first = await tenancy.createTenant({ slug: 'acme', name: 'Acme Corp' });
    const again = await tenancy.createTenant({ slug: 'acme', name: 'Acme Corp' });
    assert.equal(again.id, first.id);
    assert.equal(first.state, 'active');
    assert.deepEqual(first.createdAt, NOW);
  });

  it('the same slug with a different name is slug_taken, with the difference named', async () => {
    await assert.rejects(
      tenancy.createTenant({ slug: 'acme', name: 'Acme Ltd' }),
      (e: unknown) =>
        TenancyError.hasCode(e, 'slug_taken') && (e.failure.detail ?? '').includes('Acme Corp'),
    );
  });

  it('looks up by id and slug, and unknown refs say which ref failed', async () => {
    const bySlug = await tenancy.getTenantBySlug('acme');
    const byId = await tenancy.getTenant(bySlug.id);
    assert.equal(byId.slug, 'acme');
    await assert.rejects(
      tenancy.getTenantBySlug('ghost'),
      (e: unknown) => TenancyError.hasCode(e, 'unknown_tenant') && e.failure.ref === 'ghost',
    );
  });

  it('renames, but not to an empty name', async () => {
    const tenant = await tenancy.getTenantBySlug('acme');
    const renamed = await tenancy.renameTenant(tenant.id, 'Acme Incorporated');
    assert.equal(renamed.name, 'Acme Incorporated');
    await assert.rejects(tenancy.renameTenant(tenant.id, '  '), (e: unknown) =>
      TenancyError.hasCode(e, 'invalid_tenant'),
    );
  });

  it('archives idempotently, keeping the first archived_at; restore clears it', async () => {
    const tenant = await tenancy.createTenant({ slug: 'closing', name: 'Closing' });
    const archived = await tenancy.archiveTenant(tenant.id);
    assert.equal(archived.state, 'archived');
    assert.deepEqual(archived.archivedAt, NOW);

    const later = createTenancy({
      db,
      clock: () => new Date('2026-09-01T00:00:00Z'),
    });
    const again = await later.archiveTenant(tenant.id);
    assert.deepEqual(again.archivedAt, NOW, 'retry is not a second fact');

    const restored = await tenancy.restoreTenant(tenant.id);
    assert.equal(restored.state, 'active');
    assert.equal(restored.archivedAt, null);
  });

  it('lists by state', async () => {
    await tenancy.createTenant({ slug: 'gone', name: 'Gone' });
    const gone = await tenancy.getTenantBySlug('gone');
    await tenancy.archiveTenant(gone.id);
    const archived = await tenancy.listTenants({ state: 'archived' });
    assert.deepEqual(
      archived.map((x) => x.slug),
      ['gone'],
    );
  });

  it('resolves a request end to end: subdomain → tenant + membership', async () => {
    const extract = fromSubdomain({ baseDomain: 'example.com' });
    const tenant = await tenancy.getTenantBySlug('acme');
    await tenancy.addMember({ tenantId: tenant.id, userId: 'u-1', role: 'owner' });

    const resolved = await tenancy.resolve(
      { hostname: 'acme.example.com' },
      { userId: 'u-1', extract },
    );
    assert.equal(resolved.tenant.id, tenant.id);
    assert.equal(resolved.membership.role, 'owner');

    await assert.rejects(
      tenancy.resolve({ hostname: 'acme.example.com' }, { userId: 'stranger', extract }),
      (e: unknown) => TenancyError.hasCode(e, 'not_a_member'),
    );
    await assert.rejects(
      tenancy.resolve({ hostname: 'example.com' }, { userId: 'u-1', extract }),
      (e: unknown) => TenancyError.hasCode(e, 'no_tenant_claim'),
    );

    const closing = await tenancy.createTenant({ slug: 'shut', name: 'Shut' });
    await tenancy.addMember({ tenantId: closing.id, userId: 'u-1', role: 'owner' });
    await tenancy.archiveTenant(closing.id);
    await assert.rejects(
      tenancy.resolve({ hostname: 'shut.example.com' }, { userId: 'u-1', extract }),
      (e: unknown) => TenancyError.hasCode(e, 'tenant_archived'),
      'archived beats not-a-member: members of an archived tenant learn its state',
    );
  });
});
