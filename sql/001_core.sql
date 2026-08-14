-- tenant-kit core schema: tenants and memberships.
--
-- Everything lives in a `tenancy` schema, for the same reasons billing-kit
-- owns a `billing` schema: the host application's tables and ours must not be
-- able to collide, and a `search_path` change must not make either ambiguous.
--
-- These two tables are deliberately NOT row-level-secured. They are the
-- directory the resolve path reads *before* any tenant scope exists — you
-- cannot look a slug up under a policy that requires already knowing the
-- answer. Isolation applies to the host application's data (002_rls.sql);
-- the directory is administrative, reached through the library's own reads.
--
-- `id` is text, not uuid. billing-kit's TenantId is opaque text on every
-- ingest row, and the whole point of the shared vocabulary is that a resolved
-- id here is assignable there without a cast at the type level or in a
-- policy. The library generates UUID strings; imports may carry whatever ids
-- they already have.

CREATE SCHEMA IF NOT EXISTS tenancy;

CREATE TABLE IF NOT EXISTS tenancy.tenants (
  id          text        NOT NULL PRIMARY KEY,
  -- DNS-label rules, enforced in both layers: the library validates for a
  -- named error, the constraint holds against writers that bypass the library.
  slug        text        NOT NULL UNIQUE
              CHECK (slug ~ '^[a-z0-9](-?[a-z0-9])*$' AND char_length(slug) <= 63),
  name        text        NOT NULL CHECK (btrim(name) <> ''),
  state       text        NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'archived')),
  created_at  timestamptz NOT NULL,
  -- Archive, not delete: ledger rows and usage events keep referencing this
  -- id after the tenant leaves, and an audit needs the row to still exist.
  archived_at timestamptz,
  CHECK ((state = 'archived') = (archived_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS tenancy.memberships (
  tenant_id   text        NOT NULL REFERENCES tenancy.tenants (id),
  -- Whatever the host's auth layer calls its users. Opaque here; no FK,
  -- because the users table is deliberately not ours to declare.
  user_id     text        NOT NULL CHECK (btrim(user_id) <> ''),
  role        text        NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at  timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, user_id)
);

-- The tenant-switcher query: every tenant this user belongs to.
CREATE INDEX IF NOT EXISTS memberships_by_user ON tenancy.memberships (user_id);
