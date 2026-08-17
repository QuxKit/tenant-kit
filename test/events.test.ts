// Lifecycle events and the audit log, against a real Postgres. Two claims:
// every mutation leaves an event in its own transaction (so a rolled-back
// mutation leaves none), and an audit row appears exactly when an actor is
// known — explicitly via as(), or ambiently from a ResolvedTenant.

import assert from 'node:assert/strict';
import { before, it } from 'node:test';

import { TenancyError } from '../src/errors.ts';
import { pollEvents } from '../src/events.ts';
import { createTenancy } from '../src/instance.ts';
import { describeDb, setupDatabase } from './harness.ts';

const NOW = new Date('2026-08-16T10:00:00Z');
const DAY = 86_400_000;

const harness = await setupDatabase();

describeDb('events and audit', harness, ({ db }) => {
  let now = NOW;
  const tenancy = createTenancy({ db, clock: () => now });
  let tenantId: string;

  const drain = async () => {
    const events = await tenancy.events.poll({ limit: 1000 });
    await tenancy.events.ack(events.map((e) => e.id));
    return events;
  };

  before(async () => {
    await drain();
  });

  it('createTenant with owner records tenant_created + member_added, once', async () => {
    const t = await tenancy.createTenant({ slug: 'ev', name: 'Ev', owner: 'owner-1' });
    tenantId = t.id;
    await tenancy.createTenant({ slug: 'ev', name: 'Ev', owner: 'owner-1' }); // idempotent retry
    const events = await drain();
    assert.deepEqual(
      events.map((e) => [e.tenantId, e.type, e.actor]),
      [
        [tenantId, 'tenant_created', null],
        [tenantId, 'member_added', null],
      ],
    );
    assert.deepEqual(events[0].payload, { slug: 'ev', name: 'Ev' });
    assert.deepEqual(events[1].payload, { userId: 'owner-1', role: 'owner' });
    assert.equal(events[0].at.getTime(), NOW.getTime());
    assert.equal(events[0].ackedAt, null);
    // No actor known: no audit rows.
    assert.deepEqual(await tenancy.audit.list(tenantId), []);
  });

  it('as(actor) writes audit rows for every mutation, and idempotent no-ops write nothing', async () => {
    const admin = tenancy.as('owner-1', { via: 'test' });
    await admin.renameTenant(tenantId, 'Ev Inc');
    await admin.renameTenant(tenantId, 'Ev Inc'); // no change, no event
    await admin.addMember({ tenantId, userId: 'dev-1', role: 'member' });
    await admin.addMember({ tenantId, userId: 'dev-1', role: 'member' }); // idempotent
    await admin.setRole(tenantId, 'dev-1', 'admin');
    await admin.setRole(tenantId, 'dev-1', 'admin'); // same role
    await admin.removeMember(tenantId, 'dev-1');
    await admin.removeMember(tenantId, 'dev-1'); // absent already
    await admin.archiveTenant(tenantId);
    await admin.archiveTenant(tenantId);
    await admin.restoreTenant(tenantId);
    await admin.restoreTenant(tenantId);

    const events = await drain();
    assert.deepEqual(
      events.map((e) => e.type),
      [
        'tenant_renamed',
        'member_added',
        'member_role_changed',
        'member_removed',
        'tenant_archived',
        'tenant_restored',
      ],
    );
    assert.ok(events.every((e) => e.actor === 'owner-1'));
    assert.deepEqual(events[0].payload, { from: 'Ev', to: 'Ev Inc' });
    assert.deepEqual(events[2].payload, { userId: 'dev-1', from: 'member', to: 'admin' });
    assert.deepEqual(events[3].payload, { userId: 'dev-1', role: 'admin' });

    const audit = await tenancy.audit.list(tenantId);
    assert.deepEqual(
      audit.map((a) => [a.action, a.target, a.actor]),
      [
        ['tenant_restored', tenantId, 'owner-1'],
        ['tenant_archived', tenantId, 'owner-1'],
        ['member_removed', 'dev-1', 'owner-1'],
        ['member_role_changed', 'dev-1', 'owner-1'],
        ['member_added', 'dev-1', 'owner-1'],
        ['tenant_renamed', tenantId, 'owner-1'],
      ],
      'newest first',
    );
    assert.deepEqual(audit[5].metadata, { from: 'Ev', to: 'Ev Inc', via: 'test' });
    // paging by `before`, and filtering by actor
    const older = await tenancy.audit.list(tenantId, { before: audit[1].id, limit: 2 });
    assert.deepEqual(
      older.map((a) => a.action),
      ['member_removed', 'member_role_changed'],
    );
    assert.equal((await tenancy.audit.list(tenantId, { actor: 'nobody' })).length, 0);
  });

  it('the ambient ResolvedTenant supplies the actor', async () => {
    const resolved = await tenancy.authorize({ tenantId, via: 'test' }, 'owner-1');
    await tenancy.run(resolved, () =>
      tenancy.addMember({ tenantId, userId: 'dev-2', role: 'member' }),
    );
    // and withTenant, whose executor is scoped: use the outer instance inside it
    await tenancy.withTenant(resolved, async () => {
      await tenancy.setRole(tenantId, 'dev-2', 'admin');
    });
    // a bare tenant id in run() has no membership, so no actor
    await tenancy.run(tenantId, () => tenancy.removeMember(tenantId, 'dev-2'));

    const events = await drain();
    assert.deepEqual(
      events.map((e) => [e.type, e.actor]),
      [
        ['member_added', 'owner-1'],
        ['member_role_changed', 'owner-1'],
        ['member_removed', null],
      ],
    );
    const audit = await tenancy.audit.list(tenantId, { limit: 3 });
    assert.deepEqual(
      audit.map((a) => a.action),
      ['member_role_changed', 'member_added', 'tenant_restored'],
      'the unattributed removal wrote no audit row',
    );
  });

  it('invitations: issued (actor = inviter), superseded, accepted (actor = acceptee), revoked, resent, expired', async () => {
    const first = await tenancy.invitations.invite({
      tenantId,
      email: 'a@example.com',
      role: 'member',
      invitedBy: 'owner-1',
      ttlMs: DAY,
    });
    const second = await tenancy.invitations.invite({
      tenantId,
      email: 'a@example.com',
      role: 'member',
      invitedBy: 'owner-1',
      ttlMs: DAY,
    });
    await tenancy.invitations.accept({ token: second.token, userId: 'user-a' });
    await tenancy.invitations.accept({ token: second.token, userId: 'user-a' }); // idempotent
    const third = await tenancy.invitations.invite({
      tenantId,
      email: 'b@example.com',
      role: 'member',
      invitedBy: 'owner-1',
      ttlMs: DAY,
    });
    await tenancy.as('owner-1').invitations.revoke(third.invitation.id);
    await tenancy.as('owner-1').invitations.revoke(third.invitation.id); // idempotent
    const fourth = await tenancy.invitations.invite({
      tenantId,
      email: 'c@example.com',
      role: 'member',
      invitedBy: 'owner-1',
      ttlMs: DAY,
    });
    await tenancy.as('owner-1').invitations.resend(fourth.invitation.id);
    now = new Date(NOW.getTime() + 8 * DAY);
    try {
      assert.equal(await tenancy.invitations.sweepExpired(), 1);
    } finally {
      now = NOW;
    }

    const events = await drain();
    assert.deepEqual(
      events.map((e) => [e.type, e.actor, e.payload.invitationId]),
      [
        ['invitation_issued', 'owner-1', first.invitation.id],
        ['invitation_revoked', 'owner-1', first.invitation.id],
        ['invitation_issued', 'owner-1', second.invitation.id],
        ['member_added', 'user-a', undefined],
        ['invitation_accepted', 'user-a', second.invitation.id],
        ['invitation_issued', 'owner-1', third.invitation.id],
        ['invitation_revoked', 'owner-1', third.invitation.id],
        ['invitation_issued', 'owner-1', fourth.invitation.id],
        ['invitation_resent', 'owner-1', fourth.invitation.id],
        ['invitation_expired', null, fourth.invitation.id],
      ],
    );
    assert.equal(events[1].payload.superseded, true);
    assert.equal(events[6].payload.superseded, false);
    const audit = await tenancy.audit.list(tenantId, { actor: 'user-a' });
    assert.deepEqual(
      audit.map((a) => a.action),
      ['invitation_accepted', 'member_added'],
    );
  });

  it('roles: defined, updated, deleted', async () => {
    const admin = tenancy.as('owner-1');
    await admin.roles.define({ tenantId, name: 'viewer', permissions: ['x:read'] });
    await admin.roles.define({ tenantId, name: 'viewer', permissions: ['x:read'] }); // idempotent
    await admin.roles.update(tenantId, 'viewer', { rank: 5 });
    await admin.roles.delete(tenantId, 'viewer');
    await admin.roles.delete(tenantId, 'viewer'); // absent
    const events = await drain();
    assert.deepEqual(
      events.map((e) => [e.type, e.payload]),
      [
        ['role_defined', { name: 'viewer', permissions: ['x:read'], rank: 0 }],
        ['role_updated', { name: 'viewer', permissions: ['x:read'], rank: 5 }],
        ['role_deleted', { name: 'viewer' }],
      ],
    );
    assert.deepEqual(
      (await tenancy.audit.list(tenantId, { limit: 3 })).map((a) => [a.action, a.target]),
      [
        ['role_deleted', 'viewer'],
        ['role_updated', 'viewer'],
        ['role_defined', 'viewer'],
      ],
    );
  });

  it('a mutation that fails leaves no event: same transaction', async () => {
    await assert.rejects(tenancy.removeMember(tenantId, 'owner-1'), (e: unknown) =>
      TenancyError.hasCode(e, 'last_owner'),
    );
    // Force a failure *after* the event would have been written: a rename
    // whose transaction is rolled back by the caller.
    await assert.rejects(
      db.transaction(async (tx) => {
        const inner = createTenancy({ db: tx, clock: () => now });
        await inner.renameTenant(tenantId, 'Rolled Back');
        assert.equal((await pollEvents(tx)).length, 1, 'visible inside the transaction');
        throw new Error('abort');
      }),
      /abort/,
    );
    assert.deepEqual(await tenancy.events.poll(), []);
    assert.equal((await tenancy.getTenant(tenantId)).name, 'Ev Inc');
  });

  it('poll / ack / list semantics', async () => {
    await tenancy.addMember({ tenantId, userId: 'p-1', role: 'member' });
    await tenancy.addMember({ tenantId, userId: 'p-2', role: 'member' });
    await tenancy.addMember({ tenantId, userId: 'p-3', role: 'member' });
    const page1 = await tenancy.events.poll({ limit: 2 });
    assert.equal(page1.length, 2);
    const page2 = await tenancy.events.poll({ after: page1[1].id, limit: 2 });
    assert.equal(page2.length, 1);
    assert.equal(await tenancy.events.ack([page1[0].id, page1[0].id, 999_999_999]), 1);
    assert.equal(await tenancy.events.ack([]), 0);
    const rest = await tenancy.events.poll();
    assert.deepEqual(
      rest.map((e) => e.id),
      [page1[1].id, page2[0].id],
    );
    assert.equal(await tenancy.events.ack(rest.map((e) => e.id)), 2);
    assert.deepEqual(await tenancy.events.poll(), []);
    // list() shows acked events too, per tenant, oldest first
    const timeline = await tenancy.events.list(tenantId, { after: page1[0].id - 1, limit: 3 });
    assert.deepEqual(
      timeline.map((e) => [e.payload.userId, e.ackedAt !== null]),
      [
        ['p-1', true],
        ['p-2', true],
        ['p-3', true],
      ],
    );
    assert.equal((await tenancy.events.list('nope')).length, 0);
    // limits are clamped
    assert.equal((await pollEvents(db, { limit: 0 })).length, 0);
  });
});
