# tenant-kit schema

Numbered files, applied in order. Idempotent — every object is created
`IF NOT EXISTS` or `OR REPLACE`, so re-applying is safe.

| File | Owns |
|---|---|
| `001_core.sql` | The `tenancy` schema: `tenants`, `memberships`. |
| `002_rls.sql` | `tenancy.current_tenant()` and `tenancy.protect()` — the row-level-security machinery for the shared-schema strategy. |
| `003_invitations.sql` | `tenancy.invitations`: hashed tokens, one pending per (tenant, email), expiry. |
| `004_roles.sql` | `tenancy.roles`: per-tenant custom roles (name, permissions, rank); drops the built-in-only CHECK on `memberships.role`. |
| `005_events.sql` | `tenancy.events` (the outbox) and `tenancy.audit_log`, both written inside the mutation's transaction. |
| `006_settings.sql` | `tenants.settings jsonb` (an object; merge-patched by the library). |

Apply with anything that runs SQL files:

```sh
psql "$DATABASE_URL" -f node_modules/tenant-kit/sql/001_core.sql
psql "$DATABASE_URL" -f node_modules/tenant-kit/sql/002_rls.sql
psql "$DATABASE_URL" -f node_modules/tenant-kit/sql/003_invitations.sql
psql "$DATABASE_URL" -f node_modules/tenant-kit/sql/004_roles.sql
psql "$DATABASE_URL" -f node_modules/tenant-kit/sql/005_events.sql
psql "$DATABASE_URL" -f node_modules/tenant-kit/sql/006_settings.sql
```

Then protect your own tables (once, in your own migrations):

```sql
SELECT tenancy.protect('public.projects');            -- column defaults to tenant_id
SELECT tenancy.protect('public.documents', 'org_id'); -- or name it
```

The files ship in the npm tarball and are importable as
`tenant-kit/sql/001_core.sql` for migration tools that resolve module paths.

Two deliberate choices, documented in the files themselves:

- `tenancy.tenants` and `tenancy.memberships` are **not** row-level-secured —
  they are the directory the resolve path reads before any tenant scope
  exists.
- `tenant_id` is `text`, matching billing-kit's opaque `TenantId`, so one id
  flows through both schemas without casts.
