// Custom roles and permissions, against a real Postgres. Two things are the
// point: the built-in ladder (`atLeast`, `requireRole`, last-owner) is
// unchanged by custom roles existing, and a role in use cannot be deleted —
// including under a race with an assignment.

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { TenancyError } from '../src/errors.ts';
import { createTenancy } from '../src/instance.ts';
import { atLeast, isBuiltinRole, isRoleName, requireRole } from '../src/members.ts';
import { BUILTIN_ROLES, hasPermission, validateRoleName } from '../src/roles.ts';
import { describeDb, setupDatabase } from './harness.ts';

const NOW = new Date('2026-08-15T09:00:00Z');

describe('permission matching', () => {
  it('matches exactly, by namespace wildcard, and by star', () => {
    assert.equal(hasPermission(['projects:read'], 'projects:read'), true);
    assert.equal(hasPermission(['projects:read'], 'projects:write'), false);
    assert.equal(hasPermission(['projects:*'], 'projects:write'), true);
    assert.equal(hasPermission(['projects:*'], 'projects:a:b'), true);
    assert.equal(hasPermission(['*'], 'anything:at:all'), true);
    assert.equal(hasPermission(['projects:*'], 'billing:read'), false);
    assert.equal(hasPermission(['projects:*'], 'projects'), false, 'no colon, no namespace');
    assert.equal(hasPermission(['projects:*'], ':weird'), false);
    assert.equal(hasPermission([], 'x'), false);
  });

  it('built-ins: owner is *, admin administers, member reads', () => {
    assert.deepEqual([...BUILTIN_ROLES.owner.permissions], ['*']);
    assert.ok(hasPermission(BUILTIN_ROLES.admin.permissions, 'members:write'));
    assert.ok(!hasPermission(BUILTIN_ROLES.admin.permissions, 'tenant:archive'));
    assert.ok(hasPermission(BUILTIN_ROLES.member.permissions, 'tenant:read'));
    assert.ok(!hasPermission(BUILTIN_ROLES.member.permissions, 'members:write'));
    assert.ok(BUILTIN_ROLES.member.rank < BUILTIN_ROLES.admin.rank);
    assert.ok(BUILTIN_ROLES.admin.rank < BUILTIN_ROLES.owner.rank);
  });

  it('role names are slug-shaped and never a built-in', () => {
    assert.equal(isRoleName('billing-ops'), true);
    assert.equal(isRoleName('Billing'), false);
    assert.equal(isRoleName('1st'), false);
    assert.equal(isRoleName(''), false);
    assert.equal(isRoleName('a'.repeat(64)), false);
    assert.doesNotThrow(() => validateRoleName('viewer'));
    assert.throws(
      () => validateRoleName('admin'),
      (e: unknown) =>
        TenancyError.hasCode(e, 'invalid_role') && /reserved/.test(e.failure.reason ?? ''),
    );
    assert.throws(
      () => validateRoleName('Not Ok'),
      (e: unknown) => TenancyError.hasCode(e, 'invalid_role'),
    );
    assert.equal(isBuiltinRole('owner'), true);
    assert.equal(isBuiltinRole('viewer'), false);
  });

  it('atLeast / requireRole: built-in ladder unchanged; custom roles are off it', () => {
    assert.equal(atLeast('owner', 'admin'), true);
    assert.equal(atLeast('member', 'admin'), false);
    assert.equal(atLeast('viewer', 'member'), false, 'a custom role is not on the ladder');
    const custom = { tenantId: 't', userId: 'u', role: 'viewer', createdAt: NOW };
    assert.throws(
      () => requireRole(custom, 'member'),
      (e: unknown) => TenancyError.hasCode(e, 'forbidden') && e.failure.have === 'viewer',
    );
  });
});

const harness = await setupDatabase();

describeDb('roles', harness, ({ db }) => {
  const tenancy = createTenancy({ db, clock: () => NOW });
  let tenantId: string;
  let otherId: string;

  before(async () => {
    tenantId = (await tenancy.createTenant({ slug: 'roles', name: 'Roles', owner: 'owner-1' })).id;
    otherId = (await tenancy.createTenant({ slug: 'other', name: 'Other', owner: 'owner-2' })).id;
  });

  it('defines a role idempotently and lists it with the built-ins by rank', async () => {
    const viewer = await tenancy.roles.define({
      tenantId,
      name: 'viewer',
      permissions: ['projects:read', 'tenant:read', 'projects:read'],
      rank: 10,
    });
    assert.deepEqual(viewer.permissions, ['projects:read', 'tenant:read'], 'deduped and sorted');
    assert.equal(viewer.builtin, false);
    const again = await tenancy.roles.define({
      tenantId,
      name: 'viewer',
      permissions: ['tenant:read', 'projects:read'],
      rank: 10,
    });
    assert.deepEqual(again, viewer);
    await assert.rejects(
      tenancy.roles.define({ tenantId, name: 'viewer', permissions: ['*'], rank: 10 }),
      (e: unknown) =>
        TenancyError.hasCode(e, 'invalid_role') && /updateRole/.test(e.failure.reason ?? ''),
    );

    const list = await tenancy.roles.list(tenantId);
    assert.deepEqual(
      list.map((r) => r.name),
      ['member', 'viewer', 'admin', 'owner'],
    );
    assert.deepEqual(
      list.map((r) => r.builtin),
      [true, false, true, true],
    );
    assert.deepEqual(await tenancy.roles.list(otherId).then((l) => l.map((r) => r.name)), [
      'member',
      'admin',
      'owner',
    ]);
    const got = await tenancy.roles.get(tenantId, 'owner');
    assert.equal(got.builtin, true);
    assert.deepEqual(got.permissions, ['*']);
  });

  it('refuses malformed and reserved names, bad permissions and ranks', async () => {
    await assert.rejects(
      tenancy.roles.define({ tenantId, name: 'admin', permissions: [] }),
      (e: unknown) => TenancyError.hasCode(e, 'invalid_role'),
    );
    await assert.rejects(
      tenancy.roles.define({ tenantId, name: 'Nope', permissions: [] }),
      (e: unknown) => TenancyError.hasCode(e, 'invalid_role'),
    );
    await assert.rejects(
      tenancy.roles.define({ tenantId, name: 'ok', permissions: ['has space'] }),
      (e: unknown) =>
        TenancyError.hasCode(e, 'invalid_tenant') && e.failure.field === 'permissions',
    );
    await assert.rejects(
      tenancy.roles.define({ tenantId, name: 'ok', permissions: [], rank: -1 }),
      (e: unknown) => TenancyError.hasCode(e, 'invalid_tenant') && e.failure.field === 'rank',
    );
    await assert.rejects(
      tenancy.roles.update(tenantId, 'viewer', { rank: 1.5 }),
      (e: unknown) => TenancyError.hasCode(e, 'invalid_tenant') && e.failure.field === 'rank',
    );
    await assert.rejects(tenancy.roles.update(tenantId, 'admin', { rank: 1 }), (e: unknown) =>
      TenancyError.hasCode(e, 'invalid_role'),
    );
    await assert.rejects(tenancy.roles.delete(tenantId, 'owner'), (e: unknown) =>
      TenancyError.hasCode(e, 'invalid_role'),
    );
    await assert.rejects(tenancy.roles.update(tenantId, 'ghost', { rank: 1 }), (e: unknown) =>
      TenancyError.hasCode(e, 'unknown_role'),
    );
    await assert.rejects(tenancy.roles.get(tenantId, 'ghost'), (e: unknown) =>
      TenancyError.hasCode(e, 'unknown_role'),
    );
  });

  it('assigns custom roles via addMember, setRole and invite; unknown ones are refused', async () => {
    const m = await tenancy.addMember({ tenantId, userId: 'v-1', role: 'viewer' });
    assert.equal(m.role, 'viewer');
    await tenancy.addMember({ tenantId, userId: 'v-2', role: 'member' });
    const changed = await tenancy.setRole(tenantId, 'v-2', 'viewer');
    assert.equal(changed.role, 'viewer');
    await assert.rejects(
      tenancy.addMember({ tenantId, userId: 'v-3', role: 'ghost' }),
      (e: unknown) => TenancyError.hasCode(e, 'unknown_role') && e.failure.role === 'ghost',
    );
    await assert.rejects(tenancy.setRole(tenantId, 'v-2', 'ghost'), (e: unknown) =>
      TenancyError.hasCode(e, 'unknown_role'),
    );
    await assert.rejects(tenancy.setRole(tenantId, 'v-2', 'Bad Name'), (e: unknown) =>
      TenancyError.hasCode(e, 'invalid_role'),
    );
    // A role defined for one tenant does not exist for another.
    await assert.rejects(
      tenancy.addMember({ tenantId: otherId, userId: 'v-1', role: 'viewer' }),
      (e: unknown) => TenancyError.hasCode(e, 'unknown_role'),
    );

    const { token } = await tenancy.invitations.invite({
      tenantId,
      email: 'v4@example.com',
      role: 'viewer',
      invitedBy: 'owner-1',
    });
    const accepted = await tenancy.invitations.accept({ token, userId: 'v-4' });
    assert.equal(accepted.membership.role, 'viewer');
  });

  it('answers can / permissionsOf / require from the role', async () => {
    assert.deepEqual(await tenancy.roles.permissionsOf(tenantId, 'v-1'), [
      'projects:read',
      'tenant:read',
    ]);
    assert.equal(await tenancy.roles.can(tenantId, 'v-1', 'projects:read'), true);
    assert.equal(await tenancy.roles.can(tenantId, 'v-1', 'projects:write'), false);
    assert.equal(await tenancy.roles.can(tenantId, 'owner-1', 'anything:new'), true);
    assert.equal(await tenancy.roles.can(tenantId, 'stranger', 'tenant:read'), false);
    await assert.rejects(tenancy.roles.permissionsOf(tenantId, 'stranger'), (e: unknown) =>
      TenancyError.hasCode(e, 'not_a_member'),
    );
    await tenancy.roles.require(tenantId, 'v-1', 'projects:read');
    await assert.rejects(
      tenancy.roles.require(tenantId, 'v-1', 'projects:write'),
      (e: unknown) =>
        TenancyError.hasCode(e, 'permission_denied') && e.failure.permission === 'projects:write',
    );

    // updateRole changes what every holder can do, immediately.
    const updated = await tenancy.roles.update(tenantId, 'viewer', {
      permissions: ['projects:*'],
    });
    assert.deepEqual(updated.permissions, ['projects:*']);
    assert.equal(updated.rank, 10, 'rank untouched by a permissions-only patch');
    assert.equal(await tenancy.roles.can(tenantId, 'v-1', 'projects:write'), true);
    const reranked = await tenancy.roles.update(tenantId, 'viewer', { rank: 150 });
    assert.equal(reranked.rank, 150);
    assert.deepEqual(reranked.permissions, ['projects:*']);
    assert.deepEqual(
      (await tenancy.roles.list(tenantId)).map((r) => r.name),
      ['member', 'admin', 'viewer', 'owner'],
    );
  });

  it('a dangling role (written around the library) is unknown_role, not silence', async () => {
    await db.query(
      `INSERT INTO tenancy.memberships (tenant_id, user_id, role, created_at)
       VALUES ($1, 'rogue', 'phantom', $2)`,
      [tenantId, NOW],
    );
    await assert.rejects(tenancy.roles.can(tenantId, 'rogue', 'x'), (e: unknown) =>
      TenancyError.hasCode(e, 'unknown_role'),
    );
    await db.query(`DELETE FROM tenancy.memberships WHERE user_id = 'rogue'`);
  });

  it('refuses to delete a role in use, with counts; deletes once free', async () => {
    await assert.rejects(
      tenancy.roles.delete(tenantId, 'viewer'),
      (e: unknown) =>
        TenancyError.hasCode(e, 'role_in_use') &&
        e.failure.members === 3 &&
        e.failure.invitations === 0,
    );
    await tenancy.setRole(tenantId, 'v-1', 'member');
    await tenancy.setRole(tenantId, 'v-2', 'member');
    await tenancy.removeMember(tenantId, 'v-4');
    // A pending invitation naming it still counts.
    const { invitation } = await tenancy.invitations.invite({
      tenantId,
      email: 'pending-viewer@example.com',
      role: 'viewer',
      invitedBy: 'owner-1',
    });
    await assert.rejects(
      tenancy.roles.delete(tenantId, 'viewer'),
      (e: unknown) =>
        TenancyError.hasCode(e, 'role_in_use') &&
        e.failure.members === 0 &&
        e.failure.invitations === 1,
    );
    await tenancy.invitations.revoke(invitation.id);
    await tenancy.roles.delete(tenantId, 'viewer');
    await tenancy.roles.delete(tenantId, 'viewer'); // idempotent
    await assert.rejects(tenancy.roles.get(tenantId, 'viewer'), (e: unknown) =>
      TenancyError.hasCode(e, 'unknown_role'),
    );
  });

  it('an assignment racing a delete lands on one side or the other', async () => {
    await tenancy.roles.define({ tenantId, name: 'racer', permissions: ['x:y'] });
    // Hold the share lock in an open transaction, then try the delete.
    let releaseAssign!: () => void;
    const held = new Promise<void>((r) => {
      releaseAssign = r;
    });
    const assign = db.transaction(async (tx) => {
      const scoped = createTenancy({ db: tx, clock: () => NOW });
      await scoped.addMember({ tenantId, userId: 'racer-1', role: 'racer' });
      await held;
    });
    // Give the assignment time to take its lock, then start the delete: it
    // must block on the share lock rather than see zero members and proceed.
    await new Promise((r) => setTimeout(r, 50));
    const del = tenancy.roles.delete(tenantId, 'racer');
    let deleteSettled = false;
    del.then(
      () => {
        deleteSettled = true;
      },
      () => {
        deleteSettled = true;
      },
    );
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(deleteSettled, false, 'delete waits for the in-flight assignment');
    releaseAssign();
    await assign;
    await assert.rejects(del, (e: unknown) => TenancyError.hasCode(e, 'role_in_use'));
    await tenancy.removeMember(tenantId, 'racer-1');
    await tenancy.roles.delete(tenantId, 'racer');
  });

  it('the last-owner invariant is unchanged by custom roles', async () => {
    await tenancy.roles.define({ tenantId, name: 'super', permissions: ['*'], rank: 999 });
    await assert.rejects(tenancy.setRole(tenantId, 'owner-1', 'super'), (e: unknown) =>
      TenancyError.hasCode(e, 'last_owner'),
    );
    await tenancy.addMember({ tenantId, userId: 'owner-b', role: 'owner' });
    const moved = await tenancy.setRole(tenantId, 'owner-1', 'super');
    assert.equal(moved.role, 'super');
    assert.equal(atLeast(moved.role, 'owner'), false, 'rank 999 does not make it an owner');
    assert.equal(await tenancy.roles.can(tenantId, 'owner-1', 'tenant:archive'), true);
    await tenancy.setRole(tenantId, 'owner-1', 'owner');
  });
});
