// Per-tenant settings: merge-patch semantics, the size cap, and the event.

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { TenancyError } from '../src/errors.ts';
import { createTenancy } from '../src/instance.ts';
import { mergePatch } from '../src/settings.ts';
import { describeDb, setupDatabase } from './harness.ts';

const NOW = new Date('2026-08-16T12:00:00Z');

describe('mergePatch (RFC 7396)', () => {
  it('follows the RFC examples', () => {
    const cases: Array<[unknown, unknown, unknown]> = [
      [{ a: 'b' }, { a: 'c' }, { a: 'c' }],
      [{ a: 'b' }, { b: 'c' }, { a: 'b', b: 'c' }],
      [{ a: 'b' }, { a: null }, {}],
      [{ a: 'b', b: 'c' }, { a: null }, { b: 'c' }],
      [{ a: ['b'] }, { a: 'c' }, { a: 'c' }],
      [{ a: 'c' }, { a: ['b'] }, { a: ['b'] }],
      [{ a: { b: 'c' } }, { a: { b: 'd', c: null } }, { a: { b: 'd' } }],
      [{ a: [{ b: 'c' }] }, { a: [1] }, { a: [1] }],
      [
        ['a', 'b'],
        ['c', 'd'],
        ['c', 'd'],
      ],
      [{ a: 'b' }, ['c'], ['c']],
      [{ a: 'foo' }, null, null],
      [{ a: 'foo' }, 'bar', 'bar'],
      [{ e: null }, { a: 1 }, { e: null, a: 1 }],
      [[1, 2], { a: 'b', c: null }, { a: 'b' }],
      [{}, { a: { bb: { ccc: null } } }, { a: { bb: {} } }],
    ];
    for (const [target, patch, want] of cases)
      assert.deepEqual(mergePatch(target, patch), want, JSON.stringify({ target, patch }));
  });
});

const harness = await setupDatabase();

describeDb('settings', harness, ({ db }) => {
  const tenancy = createTenancy({ db, clock: () => NOW });
  let tenantId: string;

  before(async () => {
    tenantId = (await tenancy.createTenant({ slug: 'cfg', name: 'Cfg', owner: 'o' })).id;
    const events = await tenancy.events.poll({ limit: 1000 });
    await tenancy.events.ack(events.map((e) => e.id));
  });

  it('starts empty and merges patches without clobbering siblings', async () => {
    assert.deepEqual(await tenancy.getSettings(tenantId), {});
    const one = await tenancy.patchSettings(tenantId, {
      locale: 'en-GB',
      flags: { beta: true, dark: false },
    });
    assert.deepEqual(one, { locale: 'en-GB', flags: { beta: true, dark: false } });
    const two = await tenancy.as('o').patchSettings(tenantId, {
      flags: { dark: null, newThing: 1 },
      logo: 'https://x/y.png',
      skip: undefined,
    });
    assert.deepEqual(two, {
      locale: 'en-GB',
      flags: { beta: true, newThing: 1 },
      logo: 'https://x/y.png',
    });
    assert.deepEqual(await tenancy.getSettings(tenantId), two);

    const events = await tenancy.events.poll();
    assert.deepEqual(
      events.map((e) => [e.type, e.payload, e.actor]),
      [
        ['settings_patched', { keys: ['locale', 'flags'] }, null],
        ['settings_patched', { keys: ['flags', 'logo', 'skip'] }, 'o'],
      ],
    );
    await tenancy.events.ack(events.map((e) => e.id));
    const audit = await tenancy.audit.list(tenantId, { limit: 1 });
    assert.equal(audit[0].action, 'settings_patched');
    assert.equal(audit[0].target, tenantId);
  });

  it('a patch that changes nothing writes no event', async () => {
    const before = await tenancy.getSettings(tenantId);
    assert.deepEqual(await tenancy.patchSettings(tenantId, { locale: 'en-GB' }), before);
    assert.deepEqual(await tenancy.patchSettings(tenantId, {}), before);
    assert.deepEqual(await tenancy.events.poll(), []);
  });

  it('refuses a document over the cap without writing, with both numbers', async () => {
    const small = createTenancy({ db, clock: () => NOW, settingsMaxBytes: 200 });
    const before = await small.getSettings(tenantId);
    await assert.rejects(
      small.patchSettings(tenantId, { blob: 'x'.repeat(200) }),
      (e: unknown) =>
        TenancyError.hasCode(e, 'settings_too_large') &&
        e.failure.maxBytes === 200 &&
        e.failure.bytes > 200,
    );
    assert.deepEqual(await small.getSettings(tenantId), before, 'nothing written');
    assert.deepEqual(await tenancy.events.poll(), []);
    // A shrinking patch is fine even when the doc is already near the cap.
    await small.patchSettings(tenantId, { logo: null });
    assert.equal((await small.getSettings(tenantId)).logo, undefined);
  });

  it('validates the tenant and the patch shape', async () => {
    await assert.rejects(tenancy.getSettings('nope'), (e: unknown) =>
      TenancyError.hasCode(e, 'unknown_tenant'),
    );
    await assert.rejects(tenancy.patchSettings('nope', { a: 1 }), (e: unknown) =>
      TenancyError.hasCode(e, 'unknown_tenant'),
    );
    await assert.rejects(
      tenancy.patchSettings(tenantId, [1, 2] as unknown as Record<string, unknown>),
      (e: unknown) => TenancyError.hasCode(e, 'invalid_tenant') && e.failure.field === 'settings',
    );
  });

  it('concurrent patches to different keys both land', async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => tenancy.patchSettings(tenantId, { [`k${i}`]: i })),
    );
    const s = await tenancy.getSettings(tenantId);
    for (let i = 0; i < 8; i++) assert.equal(s[`k${i}`], i);
  });
});
