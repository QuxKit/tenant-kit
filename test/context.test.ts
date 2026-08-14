// TenantScope tests. Pure: AsyncLocalStorage semantics are what is under
// test — that concurrent request handlers cannot see each other's ambient
// tenant, which is the property everything built on `current()` leans on.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { TenantScope } from '../src/context';
import { TenancyError } from '../src/errors';

describe('TenantScope', () => {
  it('is null outside run, set inside, gone after', () => {
    const scope = new TenantScope();
    assert.equal(scope.current(), null);
    const seen = scope.run('t-1', () => scope.current()?.tenantId);
    assert.equal(seen, 't-1');
    assert.equal(scope.current(), null);
  });

  it('require throws no_tenant_context outside run', () => {
    const scope = new TenantScope();
    assert.throws(
      () => scope.require(),
      (e: unknown) => TenancyError.hasCode(e, 'no_tenant_context'),
    );
  });

  it('the inner tenant wins for its extent, then the outer returns', () => {
    const scope = new TenantScope();
    scope.run('outer', () => {
      assert.equal(scope.require().tenantId, 'outer');
      scope.run('inner', () => assert.equal(scope.require().tenantId, 'inner'));
      assert.equal(scope.require().tenantId, 'outer');
    });
  });

  it('concurrent async work each sees its own tenant across awaits', async () => {
    const scope = new TenantScope();
    const observed: string[] = [];
    await Promise.all(
      ['t-a', 't-b', 't-c'].map((id, i) =>
        scope.run(id, async () => {
          await sleep(10 - i * 3); // finish in reverse order, on purpose
          observed.push(`${id}=${scope.require().tenantId}`);
        }),
      ),
    );
    assert.deepEqual(observed.sort(), ['t-a=t-a', 't-b=t-b', 't-c=t-c']);
  });

  it('two scopes in one process are invisible to each other', () => {
    const a = new TenantScope();
    const b = new TenantScope();
    a.run('t-a', () => {
      assert.equal(b.current(), null);
    });
  });

  it('carries the full resolution when given one', () => {
    const scope = new TenantScope();
    const tenant = {
      id: 't-1',
      slug: 'acme',
      name: 'Acme',
      state: 'active' as const,
      createdAt: new Date(),
      archivedAt: null,
    };
    const membership = { tenantId: 't-1', userId: 'u-1', role: 'owner' as const, createdAt: new Date() };
    scope.run({ tenant, membership }, () => {
      const ctx = scope.require();
      assert.equal(ctx.tenantId, 't-1');
      assert.equal(ctx.tenant?.slug, 'acme');
      assert.equal(ctx.membership?.role, 'owner');
    });
  });
});
