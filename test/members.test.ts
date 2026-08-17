// Membership tests, against a real Postgres. The last-owner invariant is the
// point of this file: it is enforced under row locks, and the concurrency
// test at the bottom is the reason a read-then-write check would not do.

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { TenancyError } from '../src/errors.ts';
import { createTenancy } from '../src/instance.ts';
import { atLeast, requireRole } from '../src/members.ts';
import { describeDb, setupDatabase } from './harness.ts';

const NOW = new Date('2026-08-14T12:00:00Z');

describe('roles', () => {
  it('orders owner > admin > member', () => {
    assert.equal(atLeast('owner', 'member'), true);
    assert.equal(atLeast('admin', 'owner'), false);
    assert.equal(atLeast('member', 'member'), true);
  });

  it('forbidden carries what was needed and what was held', () => {
    const membership = { tenantId: 't-1', userId: 'u-1', role: 'member' as const, createdAt: NOW };
    assert.throws(
      () => requireRole(membership, 'admin'),
      (e: unknown) =>
        TenancyError.hasCode(e, 'forbidden') &&
        e.failure.need === 'admin' &&
        e.failure.have === 'member',
    );
  });
});

const harness = await setupDatabase();

describeDb('membership', harness, ({ db }) => {
  const tenancy = createTenancy({ db, clock: () => NOW });
  let tenantId: string;

  before(async () => {
    tenantId = (await tenancy.createTenant({ slug: 'acme', name: 'Acme' })).id;
    await tenancy.addMember({ tenantId, userId: 'owner-1', role: 'owner' });
  });

  it('adds idempotently on the same role, refuses a different role', async () => {
    const again = await tenancy.addMember({ tenantId, userId: 'owner-1', role: 'owner' });
    assert.equal(again.role, 'owner');
    await assert.rejects(
      tenancy.addMember({ tenantId, userId: 'owner-1', role: 'member' }),
      (e: unknown) => TenancyError.hasCode(e, 'already_a_member') && e.failure.role === 'owner',
      'a role change disguised as an insert is refused, not silently applied',
    );
  });

  it('lists members and a user’s tenants with their standing', async () => {
    await tenancy.addMember({ tenantId, userId: 'dev-1', role: 'member' });
    const members = await tenancy.listMembers(tenantId);
    assert.deepEqual(members.map((m) => m.userId).sort(), ['dev-1', 'owner-1']);

    const theirs = await tenancy.tenantsOf('dev-1');
    assert.equal(theirs.length, 1);
    assert.equal(theirs[0].tenant.slug, 'acme');
    assert.equal(theirs[0].membership.role, 'member');
  });

  it('changes roles, except demoting the last owner', async () => {
    const promoted = await tenancy.setRole(tenantId, 'dev-1', 'admin');
    assert.equal(promoted.role, 'admin');
    await assert.rejects(tenancy.setRole(tenantId, 'owner-1', 'member'), (e: unknown) =>
      TenancyError.hasCode(e, 'last_owner'),
    );
    // With a second owner the demotion goes through.
    await tenancy.setRole(tenantId, 'dev-1', 'owner');
    const demoted = await tenancy.setRole(tenantId, 'owner-1', 'admin');
    assert.equal(demoted.role, 'admin');
    await tenancy.setRole(tenantId, 'owner-1', 'owner'); // restore for later tests
    await tenancy.setRole(tenantId, 'dev-1', 'member');
  });

  it('removes idempotently, except the last owner', async () => {
    await tenancy.removeMember(tenantId, 'dev-1');
    await tenancy.removeMember(tenantId, 'dev-1'); // absent: a no-op, not an error
    await assert.rejects(tenancy.removeMember(tenantId, 'owner-1'), (e: unknown) =>
      TenancyError.hasCode(e, 'last_owner'),
    );
    await assert.rejects(tenancy.getMembership(tenantId, 'dev-1'), (e: unknown) =>
      TenancyError.hasCode(e, 'not_a_member'),
    );
  });

  it('two concurrent removals of the last two owners cannot both win', async () => {
    const fresh = await tenancy.createTenant({ slug: 'race', name: 'Race' });
    await tenancy.addMember({ tenantId: fresh.id, userId: 'a', role: 'owner' });
    await tenancy.addMember({ tenantId: fresh.id, userId: 'b', role: 'owner' });

    const results = await Promise.allSettled([
      tenancy.removeMember(fresh.id, 'a'),
      tenancy.removeMember(fresh.id, 'b'),
    ]);
    const failed = results.filter((r) => r.status === 'rejected');
    assert.equal(failed.length, 1, 'exactly one removal must lose the race');
    assert.ok(TenancyError.hasCode((failed[0] as PromiseRejectedResult).reason, 'last_owner'));
    const left = await tenancy.listMembers(fresh.id);
    assert.equal(left.length, 1, 'one owner survives');
  });
});
