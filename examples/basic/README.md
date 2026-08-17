# examples/basic

The README quickstart as a runnable script: create a tenant with its owner,
resolve a request, run scoped queries in one transaction, and see the
unscoped view of a protected table come back empty.

```sh
# 1. Build the kit (the example links to the checkout at ../..)
cd ../.. && pnpm install && pnpm build && cd examples/basic

# 2. A database with the shipped schema applied
createdb tenant_kit_example
psql tenant_kit_example -f ../../sql/001_core.sql
psql tenant_kit_example -f ../../sql/002_rls.sql

# 3. Run
pnpm install --ignore-workspace   # the checkout above is a pnpm workspace root
DATABASE_URL=postgres://localhost:5432/tenant_kit_example pnpm start
```

`DATABASE_URL` defaults to `postgres://localhost:5432/tenant_kit_example`.
The script creates and drops a `demo` schema and removes the tenant it made.

Note: if you connect as a superuser, "unscoped sees" will report 1 row —
Postgres exempts superusers from row-level security. Connect as a plain role
to see the policy hold (the kit's own tests do exactly that).
