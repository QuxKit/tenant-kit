// A test-free sanity check on the harness itself: it must import cleanly and
// expose the pieces every DB test file leans on, without a database in reach.
// If this fails, every DB suite would have "skipped" for the wrong reason.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as harness from './harness.ts';

describe('test harness', () => {
  it('imports and exposes the shared entry points', () => {
    assert.equal(typeof harness.setupDatabase, 'function');
    assert.equal(typeof harness.setupAppRole, 'function');
    assert.equal(typeof harness.describeDb, 'function');
    assert.equal(typeof harness.REQUIRE_DB, 'boolean');
    assert.ok(harness.SKIP_REASON.includes(harness.TEST_DATABASE_URL));
    assert.doesNotThrow(() => new URL(harness.TEST_DATABASE_URL), 'the test DB URL parses');
  });
});
