-- Per-tenant settings: one jsonb column on the tenant row.
--
-- A small bag of configuration — flags, a locale, a logo URL — that every
-- app needs and that has no business being a sibling table with its own
-- read path. It is a jsonb *object* (the CHECK), patched with JSON merge
-- patch (RFC 7396) by the library so a partial update never clobbers a
-- sibling key. The library also caps the serialized size; the column does
-- not, because the right cap is a deployment decision and a CHECK is the
-- wrong place to change one.

ALTER TABLE tenancy.tenants
  ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE tenancy.tenants DROP CONSTRAINT IF EXISTS tenants_settings_object;
ALTER TABLE tenancy.tenants
  ADD CONSTRAINT tenants_settings_object CHECK (jsonb_typeof(settings) = 'object');
