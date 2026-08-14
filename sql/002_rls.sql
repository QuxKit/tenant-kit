-- Row-level security machinery for the shared-schema strategy.
--
-- Two objects, and a contract with src/isolation.ts:
--
--   tenancy.current_tenant()   reads the transaction-local setting
--                              `tenancy.tenant_id`, which scopedExecutor sets
--                              via set_config(…, true). NULL outside a scope.
--   tenancy.protect(table)     enables FORCED row-level security on a host
--                              table and installs one policy comparing its
--                              tenant column to current_tenant().
--
-- Under this contract an unscoped connection does not error — it sees an
-- empty table. That is the designed failure mode: the forgotten-WHERE bug
-- degrades from "returns everyone's rows" to "returns no rows", which is the
-- difference between a breach disclosure and a bug report.

-- NULL if the setting is absent OR empty: set_config cannot unset a GUC, only
-- write '', and a policy comparing against '' would be an equality check on a
-- string no tenant id should ever be — but "should" is not a guarantee, so
-- the NULLIF makes absent and empty the same non-tenant.
CREATE OR REPLACE FUNCTION tenancy.current_tenant() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('tenancy.tenant_id', true), '')
$$;

-- Enable forced RLS on `target` and install the isolation policy.
--
-- FORCE is the load-bearing word. Without it the table's owner bypasses every
-- policy — and the owner role is exactly what most app connection strings and
-- every test harness authenticate as, so unforced RLS passes review and does
-- nothing in production.
--
-- The policy compares `tenant_column = current_tenant()::<column type>`. The
-- cast goes on the function side, not the column side, so a uuid tenant
-- column keeps its index; casting the column would force a scan and, worse,
-- make the planner's cost of isolation visible enough that someone removes it.
--
-- Idempotent: re-running replaces the policy in place.
CREATE OR REPLACE FUNCTION tenancy.protect(target regclass, tenant_column name DEFAULT 'tenant_id')
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  coltype text;
BEGIN
  SELECT format_type(a.atttypid, a.atttypmod) INTO coltype
    FROM pg_attribute a
   WHERE a.attrelid = target AND a.attname = tenant_column AND NOT a.attisdropped;
  IF coltype IS NULL THEN
    RAISE EXCEPTION 'tenancy.protect: % has no column %', target, tenant_column;
  END IF;

  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
  EXECUTE format('DROP POLICY IF EXISTS tenancy_isolation ON %s', target);
  EXECUTE format(
    'CREATE POLICY tenancy_isolation ON %s
       USING (%I = tenancy.current_tenant()::%s)
       WITH CHECK (%I = tenancy.current_tenant()::%s)',
    target, tenant_column, coltype, tenant_column, coltype
  );
END
$$;
