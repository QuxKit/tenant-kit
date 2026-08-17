// The last-owner race, with the interleaving forced.
//
// members.test.ts races two removals and asserts one loses. That test passes
// on timing most of the time even when the locking is wrong; this one slows
// every statement so both transactions are guaranteed to have taken their
// first lock before either takes its second. With per-user-then-owners
// locking that is a textbook deadlock (40P01) and Postgres kills one side
// with the wrong error. With one ordered lock statement, the loser waits,
// then fails cleanly with `last_owner`.

import assert from 'node:assert/strict';
import { it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { TenancyError } from '../src/errors.ts';
import { createTenancy } from '../src/instance.ts';
import type { SqlExecutor } from '../src/types.ts';
import { describeDb, setupDatabase } from './harness.ts';

/** Every statement pauses first, so concurrent transactions interleave. */
function slow(db: SqlExecutor, ms: number): SqlExecutor {
  const wrap = (inner: SqlExecutor): SqlExecutor => ({
    query: async (text, params) => {
      await sleep(ms);
      return inner.query(text, params);
    },
    transaction: (fn) => inner.transaction((tx) => fn(wrap(tx))),
  });
  return wrap(db);
}

const harness = await setupDatabase();

describeDb('owner-row lock ordering', harness, ({ db }) => {
  const tenancy = createTenancy({ db: slow(db, 30) });

  const codes = (results: PromiseSettledResult<unknown>[]) =>
    results.map((r) =>
      r.status === 'fulfilled'
        ? 'ok'
        : TenancyError.is(r.reason)
          ? r.reason.code
          : String((r.reason as { code?: string }).code ?? r.reason),
    );

  it('two removals of the last two owners: one succeeds, one is last_owner, never 40P01', async () => {
    const t = await tenancy.createTenant({ slug: 'lock-remove', name: 'Lock' });
    await tenancy.addMember({ tenantId: t.id, userId: 'a', role: 'owner' });
    await tenancy.addMember({ tenantId: t.id, userId: 'b', role: 'owner' });

    const results = await Promise.allSettled([
      tenancy.removeMember(t.id, 'a'),
      tenancy.removeMember(t.id, 'b'),
    ]);
    assert.deepEqual(codes(results).sort(), ['last_owner', 'ok']);
    assert.equal((await tenancy.listMembers(t.id)).length, 1);
  });

  it('a removal racing a demotion resolves the same way', async () => {
    const t = await tenancy.createTenant({ slug: 'lock-demote', name: 'Lock' });
    await tenancy.addMember({ tenantId: t.id, userId: 'a', role: 'owner' });
    await tenancy.addMember({ tenantId: t.id, userId: 'b', role: 'owner' });

    const results = await Promise.allSettled([
      tenancy.removeMember(t.id, 'b'),
      tenancy.setRole(t.id, 'a', 'admin'),
    ]);
    assert.deepEqual(codes(results).sort(), ['last_owner', 'ok']);
    const owners = (await tenancy.listMembers(t.id)).filter((m) => m.role === 'owner');
    assert.equal(owners.length, 1, 'exactly one owner remains');
  });
});
