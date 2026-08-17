// routedExecutor: a bounded LRU over a route function. No database — the
// executors are stubs; what is under test is which ones get built, kept,
// evicted and disposed.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { routedExecutor } from '../src/isolation.ts';
import type { SqlExecutor } from '../src/types.ts';

function stub(id: string): SqlExecutor & { id: string } {
  return {
    id,
    query: async () => [],
    transaction: async (fn) => fn(stub(id)),
  };
}

describe('routedExecutor', () => {
  it('memoizes per tenant', () => {
    let built = 0;
    const router = routedExecutor((id) => {
      built++;
      return stub(id);
    });
    assert.equal(router('a'), router('a'));
    router('b');
    assert.equal(built, 2);
    assert.equal(router.size, 2);
  });

  it('evicts the least recently used past max, disposing it', async () => {
    const disposed: string[] = [];
    const router = routedExecutor((id) => stub(id), {
      max: 2,
      dispose: (_db, id) => {
        disposed.push(id);
      },
    });
    const a = router('a');
    router('b');
    router('a'); // touch a: b is now the LRU
    router('c'); // over the bound: b goes
    await Promise.resolve();
    assert.deepEqual(disposed, ['b']);
    assert.equal(router.size, 2);
    assert.equal(router('a'), a, 'a survived because it was used more recently');
    assert.notEqual(router('b'), undefined);
    await Promise.resolve();
    assert.deepEqual(disposed, ['b', 'c'], 'routing b again evicted the new LRU, c');
  });

  it('close() disposes everything and empties the cache; routing afterwards rebuilds', async () => {
    const disposed: string[] = [];
    let built = 0;
    const router = routedExecutor(
      (id) => {
        built++;
        return stub(id);
      },
      { dispose: async (_db, id) => void disposed.push(id) },
    );
    router('a');
    router('b');
    await router.close();
    assert.deepEqual(disposed.sort(), ['a', 'b']);
    assert.equal(router.size, 0);
    router('a');
    assert.equal(built, 3, 'a was rebuilt after close');
  });

  it('a rejecting dispose on eviction does not surface as an unhandled rejection', async () => {
    const router = routedExecutor((id) => stub(id), {
      max: 1,
      dispose: async () => {
        throw new Error('pool.end failed');
      },
    });
    router('a');
    router('b');
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(router.size, 1);
  });

  it('refuses a nonsensical max', () => {
    assert.throws(() => routedExecutor((id) => stub(id), { max: 0 }), RangeError);
  });
});
