# Isolation: choosing where the boundary lives

Three strategies, one decision. This doc exists so the decision is made once,
on the record, instead of re-argued each time a new table ships.

## The spectrum

| | Shared schema + RLS | Schema-per-tenant | Database-per-tenant |
|---|---|---|---|
| The boundary is | A policy the database enforces per row | A `search_path` | A connection string |
| Enforced by | Postgres, on every query, including yours | Discipline at connection setup | Physics — the rows aren't there |
| Migrations | One schema, one migration | N schemas × every migration | N databases × every migration, plus provisioning |
| Cross-tenant reports | One query | N-way UNION or ETL | ETL |
| Noisy-neighbor blast radius | Shared everything | Shared instance | Isolated |
| Per-tenant restore / export / deletion | Row-filtered, careful | `pg_dump -n`, decent | `pg_dump`, trivial |
| Tenants it comfortably serves | Thousands+ | Hundreds | Tens (the contract-requires-it tier) |
| tenant-kit support | **First-class**: `protect()` + `scopedExecutor` | Via `routedExecutor` (a routed executor may set `search_path`) | Via `routedExecutor` |

**Default to shared schema + RLS.** Move a tenant out when a contract, a
regulator, or a genuinely enormous tenant forces it — and note that the
strategies compose: `routedExecutor` can send ninety-nine tenants at a shared
RLS-protected database and the one whale at its own.

## How the RLS strategy actually works

Two sides of one contract, one name in the middle: the transaction-local
setting `tenancy.tenant_id`.

**SQL side** (`sql/002_rls.sql`):

```sql
SELECT tenancy.protect('public.projects');
```

installs, per table:

```sql
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolation ON public.projects
  USING      (tenant_id = tenancy.current_tenant()::text)
  WITH CHECK (tenant_id = tenancy.current_tenant()::text);
```

**TypeScript side** (`src/isolation.ts`): `tenancy.db()` wraps every
statement in a transaction that first runs
`SELECT set_config('tenancy.tenant_id', $1, true)`.

The row is visible iff its tenant column equals the setting. No setting —
`current_tenant()` is NULL — and the policy is false for every row: the
unscoped query returns nothing, the unscoped insert is rejected.

### The load-bearing details

Each of these was a production incident somewhere before it was a rule here.

- **`FORCE`.** Plain RLS exempts the table's owner — and the owner role is
  what most app connection strings authenticate as. Unforced RLS passes
  review and does nothing. `protect()` forces, unconditionally.
- **Superusers bypass RLS regardless.** So your app must not connect as one,
  and the test suite makes a dedicated non-superuser role precisely so its
  green checkmarks mean something (`test/harness.ts` explains).
- **`SET LOCAL`, never `SET`.** A plain `SET` outlives its transaction; on a
  pooled connection the next borrower inherits the previous request's tenant.
  This is the classic RLS-on-a-pool bug, and it is why `scopedExecutor`
  refuses to run any statement outside a transaction. There is a test that
  scopes a query and then asserts the pool's next user sees nothing.
- **The cast goes on the function.** `tenant_id = current_tenant()::uuid`
  keeps the column's index; `tenant_id::text = current_tenant()` forces a
  scan on every policied query, and slow isolation is isolation someone will
  eventually remove. `protect()` reads the column's type from the catalog and
  casts the constant side.
- **`WITH CHECK`, not just `USING`.** `USING` filters what you read;
  `WITH CHECK` refuses writes that place rows outside your scope. Without it,
  a scoped session can insert rows *it can never see again* into another
  tenant — a write leak with no read to notice it. The cross-tenant UPDATE
  (moving a row across the boundary) is refused by the same clause.
- **Empty, not error.** An unscoped read returning zero rows rather than
  raising is a deliberate trade: it makes the forgotten-scope bug loud in
  QA ("where did the data go?") but harmless in production. If you would
  rather fail closed with an exception, add a
  `current_tenant() IS NOT NULL`-asserting trigger — the setting name is
  exported as `TENANT_SETTING` for exactly this kind of extension.

### What not to protect

The `tenancy.tenants` and `tenancy.memberships` tables. They are the
directory that `resolve()` reads *before* any scope exists; a policy on them
would require knowing the answer to ask the question. They carry no host
data. Reach them through the library, or through `unscopedDb()` — which is
named that so the reach reads as deliberate.

## The other two strategies, honestly

`routedExecutor(route, { max, dispose })` memoizes `tenantId → SqlExecutor`
in a least-recently-used cache bounded by `max` (default 100), calling
`dispose` for what falls off — and `close()` for everything at shutdown.
That is the whole offering, and the restraint is the point: the hard parts of physical
isolation are **provisioning** (who creates the database when a tenant signs
up at 3am), **migration fan-out** (a bad migration now fails per-tenant,
partially), and **connection budgets** (every isolated tenant is a pool;
Postgres connections are not free). Those are operational decisions with
your name on the pager, not defaults a library should pick.

What the library does guarantee: the routing function is consulted once per
tenant while its executor is cached, the executor is reused, evicted
executors are handed to `dispose` (end the pool there), and everything downstream — including
billing-kit — sees the same `SqlExecutor` interface regardless of which
strategy produced it. Moving one tenant from the shared database to its own
is a change to your `route` function and a data copy, not an API migration.
