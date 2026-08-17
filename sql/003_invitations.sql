-- Invitations: the workflow that brings a user into a tenant.
--
-- An invitation names a tenant, an email, and the role the invitee will hold.
-- The token the invitee presents is stored only as its sha256; the clear
-- text is returned once, at issue time, and never again — a table dump must
-- not be a bag of bearer credentials.
--
-- `email` is what the invitation was *sent* to; it is not verified against
-- the accepting `user_id`, because tenant-kit has no users table and no way
-- to know a user's email. Possession of the token is the proof, which is
-- why the token is random, hashed at rest, and single-use per user.
--
-- `role` is checked non-empty here and validated by the library. It is not
-- a CHECK against the three built-in names, because roles are about to
-- become per-tenant (004_roles.sql) and a shipped migration is never edited.

CREATE TABLE IF NOT EXISTS tenancy.invitations (
  id           text        NOT NULL PRIMARY KEY,
  tenant_id    text        NOT NULL REFERENCES tenancy.tenants (id),
  -- Stored lower-cased by the library; compared case-insensitively.
  email        text        NOT NULL CHECK (btrim(email) <> ''),
  role         text        NOT NULL CHECK (btrim(role) <> ''),
  token_hash   text        NOT NULL UNIQUE,
  invited_by   text        NOT NULL CHECK (btrim(invited_by) <> ''),
  state        text        NOT NULL DEFAULT 'pending'
               CHECK (state IN ('pending', 'accepted', 'revoked', 'expired')),
  created_at   timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  accepted_by  text,
  revoked_at   timestamptz,
  CHECK ((state = 'accepted') = (accepted_at IS NOT NULL)),
  CHECK ((state = 'accepted') = (accepted_by IS NOT NULL)),
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL))
);

-- At most one pending invitation per (tenant, email): a fresh invite for an
-- address that already has one supersedes it (the library revokes the old
-- row under an advisory lock before inserting). The index is the backstop.
CREATE UNIQUE INDEX IF NOT EXISTS invitations_one_pending
  ON tenancy.invitations (tenant_id, email) WHERE state = 'pending';

-- The tenant's invitation list, and the sweep's scan.
CREATE INDEX IF NOT EXISTS invitations_by_tenant ON tenancy.invitations (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS invitations_pending_expiry
  ON tenancy.invitations (expires_at) WHERE state = 'pending';
