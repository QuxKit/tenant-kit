-- Custom roles: per-tenant names with a permission list and a rank.
--
-- The three built-ins — owner, admin, member — are *implied*: they have no
-- row here, cannot be redefined or deleted, and their permission sets are
-- constants in the library (src/roles.ts, BUILTIN_ROLES). This table holds
-- everything a tenant adds beside them.
--
-- `permissions` is an application vocabulary. tenant-kit stores and matches
-- the strings (`exact`, `ns:*`, `*`); it does not know what `projects:write`
-- means, and it should not.
--
-- The memberships CHECK from 001 pinned `role` to the three names; it has to
-- go for custom names to be assignable. Membership rows are validated by the
-- library against this table (built-in, or a row for the same tenant),
-- under a share lock on the role row so a concurrent delete cannot orphan
-- them. No FK: the built-ins have no row to reference.

CREATE TABLE IF NOT EXISTS tenancy.roles (
  tenant_id    text        NOT NULL REFERENCES tenancy.tenants (id),
  -- Same shape as a slug: what appears in a URL or a config file.
  name         text        NOT NULL
               CHECK (name ~ '^[a-z][a-z0-9_-]*$' AND char_length(name) <= 63)
               CHECK (name NOT IN ('owner', 'admin', 'member')),
  permissions  text[]      NOT NULL DEFAULT '{}',
  -- Where the role sits in the tenant's own ordering. Built-ins are 0 / 100 /
  -- 200 (member / admin / owner); a custom rank is any non-negative integer.
  rank         integer     NOT NULL DEFAULT 0 CHECK (rank >= 0),
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, name)
);

ALTER TABLE tenancy.memberships DROP CONSTRAINT IF EXISTS memberships_role_check;
ALTER TABLE tenancy.memberships DROP CONSTRAINT IF EXISTS memberships_role_nonempty;
ALTER TABLE tenancy.memberships ADD CONSTRAINT memberships_role_nonempty CHECK (btrim(role) <> '');

-- deleteRole's "is it in use" count, and setRole's validation.
CREATE INDEX IF NOT EXISTS memberships_by_role ON tenancy.memberships (tenant_id, role);
