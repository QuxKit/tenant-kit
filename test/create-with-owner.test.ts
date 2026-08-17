// Owner at creation: the tenant and its first owner are one transaction.
// The test that matters is the injected failure — if the membership insert
// dies, the tenant must not exist either, because a tenant with zero owners
// is a tenant nobody can administer.

import assert from 'node:assert/strict';
import { it } from 'node:test';

import { TenancyError } from '../src/errors.ts';
import { createTenancy } from '../src/instance.ts';
import type { SqlExecutor } from '../src/types.ts';
import { describeDb, setupDatabase } from './harness.ts';

const NOW = new Date('2026-08-14T12:00:00Z');

/** An executor whose statements matching `pattern` throw, inside transactions too. */
function failing(db: SqlExecutor, pattern: RegExp): SqlExecutor {
  const wrap = (inner: SqlExecutor): SqlExecutor => ({
    query: (text, params) => {
      if (pattern.test(text)) return Promise.reject(new Error('injected failure'));
      return inner.query(text, params);
    },
    transaction: (fn) => inner.transaction((tx) => fn(wrap(tx))),
  });
  return wrap(db);
}

const harness = await setupDatabase();

describeDb('createTenant with an owner', harness, ({ db }) => {
  const tenancy = createTenancy({ db, clock: () => NOW });

  it('creates the tenant and its owner membership together', async () => {
    const { tenant, membership } = await tenancy.createTenantWithOwner({
      slug: 'acme',
      name: 'Acme',
      owner: 'u-1',
    });
    assert.equal(tenant.slug, 'acme');
    assert.equal(membership.role, 'owner');
    assert.equal(membership.userId, 'u-1');
    assert.equal(membership.tenantId, tenant.id);
    const members = await tenancy.listMembers(tenant.id);
    assert.deepEqual(
      members.map((m) => [m.userId, m.role]),
      [['u-1', 'owner']],
    );
  });

  it('createTenant({ owner }) is the same path, returning the tenant', async () => {
    const tenant = await tenancy.createTenant({ slug: 'beta', name: 'Beta', owner: 'u-2' });
    const membership = await tenancy.getMembership(tenant.id, 'u-2');
    assert.equal(membership.role, 'owner');
  });

  it('an exact retry is idempotent', async () => {
    const again = await tenancy.createTenantWithOwner({ slug: 'acme', name: 'Acme', owner: 'u-1' });
    assert.equal(again.tenant.slug, 'acme');
    assert.equal(again.membership.userId, 'u-1');
    assert.equal((await tenancy.listMembers(again.tenant.id)).length, 1);
  });

  it('a retry naming a different owner is refused, not a silent grant', async () => {
    await assert.rejects(
      tenancy.createTenantWithOwner({ slug: 'acme', name: 'Acme', owner: 'intruder' }),
      (e: unknown) =>
        TenancyError.hasCode(e, 'slug_taken') && (e.failure.detail ?? '').includes('intruder'),
    );
    const acme = await tenancy.getTenantBySlug('acme');
    assert.equal((await tenancy.listMembers(acme.id)).length, 1, 'no membership was added');
  });

  it('refuses an empty owner before touching the database', async () => {
    await assert.rejects(
      tenancy.createTenantWithOwner({ slug: 'nobody', name: 'Nobody', owner: '  ' }),
      (e: unknown) => TenancyError.hasCode(e, 'invalid_tenant') && e.failure.field === 'owner',
    );
    await assert.rejects(tenancy.getTenantBySlug('nobody'), (e: unknown) =>
      TenancyError.hasCode(e, 'unknown_tenant'),
    );
  });

  it('a zero-owner tenant is not reachable: if the owner insert fails, the tenant is gone', async () => {
    const broken = createTenancy({
      db: failing(db, /INSERT INTO tenancy\.memberships/),
      clock: () => NOW,
    });
    await assert.rejects(
      broken.createTenantWithOwner({ slug: 'orphan', name: 'Orphan', owner: 'u-3' }),
      /injected failure/,
    );
    await assert.rejects(
      tenancy.getTenantBySlug('orphan'),
      (e: unknown) => TenancyError.hasCode(e, 'unknown_tenant'),
      'the tenant insert was rolled back with the membership insert',
    );
  });
});
