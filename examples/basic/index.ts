// The README quickstart, runnable. Creates a tenant with its first owner,
// resolves a request the way middleware would, then queries a protected
// table through the scoped executor and shows the unscoped view is empty.
//
// Run it with the commands in ./README.md. It needs a Postgres it may write
// to; it creates a `demo` schema and drops it again at the end.

import { createTenancy, firstOf, fromHeader, fromSubdomain } from '@quxkit/tenant-kit';
import { pgExecutor } from '@quxkit/tenant-kit/pg';
import pg from 'pg';

const url = process.env.DATABASE_URL ?? 'postgres://localhost:5432/tenant_kit_example';
const pool = new pg.Pool({ connectionString: url });
const db = pgExecutor(pool);
const tenancy = createTenancy({ db });

// A throwaway table to protect. Your app would do this in a migration.
await db.query('CREATE SCHEMA IF NOT EXISTS demo');
await db.query(`
  CREATE TABLE IF NOT EXISTS demo.projects (
    id serial PRIMARY KEY, tenant_id text NOT NULL, name text NOT NULL)`);
await db.query(`SELECT tenancy.protect('demo.projects')`);

// Once: a tenant and its first owner, atomically.
const acme = await tenancy.createTenant({ slug: 'acme', name: 'Acme Corp', owner: 'user-1' });
console.log('tenant', acme.slug, acme.id);

// Every request: extract a claim, authorize it, make the tenant ambient.
const extract = firstOf(fromSubdomain({ baseDomain: 'example.com' }), fromHeader());
const resolved = await tenancy.resolve(
  { hostname: 'acme.example.com' },
  { userId: 'user-1', extract },
);
console.log('resolved as', resolved.membership.role);

// Inside a request: one transaction, scoped once, several statements.
await tenancy.withTenant(resolved, async (tx) => {
  await tx.query(`INSERT INTO demo.projects (tenant_id, name) VALUES ($1, 'first')`, [acme.id]);
  const rows = await tx.query<{ name: string }>('SELECT name FROM demo.projects');
  console.log(
    'scoped sees',
    rows.map((r) => r.name),
  );
});

// The unscoped view of a protected table is empty, not everything — that is
// what tenancy.protect() buys. (As a superuser you would see the row: RLS
// does not apply to superusers, which is why the tests use a plain role.)
const unscoped = await db.query('SELECT name FROM demo.projects');
console.log('unscoped sees', unscoped.length, 'rows');

await db.query('DROP SCHEMA demo CASCADE');
await db.query(`DELETE FROM tenancy.memberships WHERE tenant_id = $1`, [acme.id]);
await db.query(`DELETE FROM tenancy.tenants WHERE id = $1`, [acme.id]);
await pool.end();
