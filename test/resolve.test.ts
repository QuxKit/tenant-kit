// Extractor tests. Pure functions, no database: what each strategy claims
// from a request, and what it refuses to claim.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { firstOf, fromClaim, fromHeader, fromPath, fromSubdomain } from '../src/resolve';

describe('fromSubdomain', () => {
  const extract = fromSubdomain({ baseDomain: 'example.com' });

  it('claims the single label below the base domain', () => {
    assert.deepEqual(extract({ hostname: 'acme.example.com' }), {
      slug: 'acme',
      via: 'subdomain of example.com',
    });
  });

  it('strips a port and lowercases', () => {
    assert.equal(extract({ hostname: 'ACME.Example.com:3000' })?.slug, 'acme');
  });

  it('reads the host header when hostname is absent', () => {
    assert.equal(extract({ headers: { Host: 'acme.example.com' } })?.slug, 'acme');
  });

  it('claims nothing for the base domain itself', () => {
    assert.equal(extract({ hostname: 'example.com' }), null);
  });

  it('claims nothing for a different domain that merely ends alike', () => {
    assert.equal(extract({ hostname: 'evilexample.com' }), null);
  });

  it('refuses to guess between two labels', () => {
    assert.equal(extract({ hostname: 'a.b.example.com' }), null);
  });
});

describe('fromHeader', () => {
  it('matches the header name case-insensitively and takes the first value', () => {
    const extract = fromHeader();
    assert.equal(extract({ headers: { 'X-Tenant': 'acme' } })?.slug, 'acme');
    assert.equal(extract({ headers: { 'x-tenant': ['acme', 'other'] } })?.slug, 'acme');
    assert.equal(extract({ headers: {} }), null);
    assert.equal(extract({ headers: { 'x-tenant': '' } }), null);
  });
});

describe('fromPath', () => {
  it('claims the segment after the prefix and nothing else', () => {
    const extract = fromPath();
    assert.equal(extract({ path: '/t/acme/settings' })?.slug, 'acme');
    assert.equal(extract({ path: '/t/acme' })?.slug, 'acme');
    assert.equal(extract({ path: '/other/acme' }), null);
    assert.equal(extract({ path: '/t/' }), null);
  });
});

describe('fromClaim', () => {
  it('claims a tenant id, not a slug, and only a non-empty string', () => {
    const extract = fromClaim();
    assert.deepEqual(extract({ claims: { tenant_id: 't-1' } }), {
      tenantId: 't-1',
      via: 'claim tenant_id',
    });
    assert.equal(extract({ claims: { tenant_id: 7 } }), null);
    assert.equal(extract({ claims: {} }), null);
    assert.equal(extract({}), null);
  });
});

describe('firstOf', () => {
  it('is precedence order, first claim wins', () => {
    const extract = firstOf(
      fromSubdomain({ baseDomain: 'example.com' }),
      fromHeader('x-tenant'),
    );
    const both = { hostname: 'sub.example.com', headers: { 'x-tenant': 'header' } };
    assert.equal(extract(both)?.slug, 'sub');
    assert.equal(extract({ headers: { 'x-tenant': 'header' } })?.slug, 'header');
    assert.equal(extract({}), null);
  });
});
