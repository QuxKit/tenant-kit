# @quxkit/tenant-kit

**QuxKit** · green stone · multi-tenancy

Multi-tenancy as a library, for the app you already run.

```
 request
   │
   ▼
 extract       claim, untrusted            ─┐
   │ TenantClaim                            │
   ▼                                        │  @quxkit/tenant-kit
 authorize     directory + membership       │  Apache-2.0
   │ ResolvedTenant                         │
   ▼                                        │
 context       ambient tenant ──▶ handlers  │
   │                                        │
   ▼                                        │
 isolation     RLS-scoped executor         ─┘
   │ SET LOCAL, per transaction
   ▼
 your tables   tenancy.protect()

 Extraction never authorizes; authorization never trusts the request.
```

_Rendered diagrams (mermaid): [docs/DIAGRAMS.md](https://github.com/QuxKit/tenant-kit/blob/main/docs/DIAGRAMS.md)._

tenant-kit owns the framed column: what a tenant **is** (a directory of tenants
and memberships), how a request **becomes** one (extraction, then
authorization — never one without the other), how the current tenant travels
through your code (AsyncLocalStorage), and how the database refuses to serve
anyone else's rows (row-level security you turn on per table). Your app owns
everything else — its users, its auth, its tables, its permissions.

Apache-2.0, sibling to [billing-kit](https://github.com/QuxKit/billing-kit):
same license, same executor interface, same design rules. A tenant resolved
here is the `tenantId` on every usage event there — see
[docs/BILLING_KIT.md](docs/BILLING_KIT.md).

## The problem it solves

Multi-tenancy usually arrives in one of two shapes, and both put the tenant
boundary somewhere you don't control:

- **A hosted identity platform** — Clerk Organizations, WorkOS, Auth0
  Organizations — that owns your org model, your user model, and a slice of
  your login flow, priced per active user, reached over the network on every
  request.
- **Hand-rolled middleware** — a `req.tenant` set from the subdomain, a
  `WHERE tenant_id = $1` appended to five hundred queries by convention, and
  an incident review the week one of them forgets.

tenant-kit is a third shape: **a library you embed.** You `import` the tenant
directory, resolution, context and isolation into the app you already run, on
the Postgres and the auth you already use. No per-seat pricing on your own
customers, and no convention where an invariant should be.

|  | What it costs you | Where the tenant boundary lives |
|---|---|---|
| Hosted orgs (Clerk, WorkOS, Auth0) | Per-user pricing, forever | Their API, their user model |
| Hand-rolled | Every forgotten WHERE clause | Convention and code review |
| **tenant-kit** | **A schema and two imports** | **Your database, enforced by it** |

## What it refuses to be

The scope line is drawn once, here, and every module comment in `src/`
defends a piece of it:

- **Not an auth product.** `UserId` is opaque. Whoever your auth layer says is
  calling — a Clerk id, an Auth0 sub, your sessions table's primary key —
  tenant-kit checks *membership*, never identity. There is no users table in
  this schema and there never will be.
- **Not an RBAC engine.** Three roles — `owner`, `admin`, `member` — and one
  comparison, `atLeast`. Permissions-on-resources is your application's
  vocabulary, built on top.
- **Not billing.** Tenants get billed by [billing-kit](docs/BILLING_KIT.md),
  which consumes the `tenantId` this library produces. Neither imports the
  other.

The systems on the other side of that line plug in through
[tenant-kit-adapters](https://github.com/QuxKit/tenant-kit-adapters):
enterprise SSO over any OIDC IdP (per-tenant connections, group→role
mapping, JIT provisioning), SCIM 2.0 directory provisioning, and
role-mirroring bridges into RBAC engines like OpenFGA — each one an adapter
conforming to a small contract, none of them moving the scope line.

## Quickstart

```sh
pnpm add @quxkit/tenant-kit
psql "$DATABASE_URL" -f node_modules/tenant-kit/sql/001_core.sql
psql "$DATABASE_URL" -f node_modules/tenant-kit/sql/002_rls.sql
```

Wire it to any `pg.Pool` (the ~10-line adapter is in
[`test/pg-executor.ts`](test/pg-executor.ts); it satisfies billing-kit's
executor too):

```ts
import { createTenancy, firstOf, fromSubdomain, fromHeader } from '@quxkit/tenant-kit';

const tenancy = createTenancy({ db });

// Once: a tenant and its first owner.
const acme = await tenancy.createTenant({ slug: 'acme', name: 'Acme Corp' });
await tenancy.addMember({ tenantId: acme.id, userId: user.id, role: 'owner' });

// Every request: extract a claim, authorize it, make the tenant ambient.
const extract = firstOf(fromSubdomain({ baseDomain: 'example.com' }), fromHeader());

app.use(async (req, res, next) => {
  const resolved = await tenancy.resolve(
    { hostname: req.hostname, path: req.path, headers: req.headers },
    { userId: req.user.id, extract },   // req.user: your auth layer's verdict
  );
  tenancy.run(resolved, next);
});

// Handlers: the ambient tenant, and a database that can only see its rows.
app.get('/projects', async (req, res) => {
  const rows = await tenancy.db().query('SELECT * FROM projects');
  res.json(rows); // no WHERE tenant_id — the policy is the WHERE
});
```

Turn on isolation per table, in your own migrations:

```sql
SELECT tenancy.protect('public.projects');            -- column defaults to tenant_id
SELECT tenancy.protect('public.documents', 'org_id'); -- or name it
```

`protect` enables **forced** row-level security and installs one policy:
rows are visible iff their tenant column equals the transaction-local tenant
that `tenancy.db()` set. A query that escapes scoping sees an empty table —
the forgotten-WHERE bug degrades from a data leak to a bug report.

## The two-halves rule

The API's one security idea, worth stating outside a docstring:

```
extraction:      request  →  TenantClaim      (pure; the caller's assertion)
authorization:   claim    →  ResolvedTenant   (directory lookup + membership check)
```

An extractor cannot return a `Tenant`. Nothing downstream accepts a
`TenantClaim`. So "trust the subdomain" — the shape of most multi-tenant
breaches — is not expressible through this API by accident. `fromSubdomain`,
`fromHeader`, `fromPath` and `fromClaim` compose with `firstOf`; writing your
own extractor is writing one pure function.

Every failure is a typed code on `TenancyError` — `unknown_tenant`,
`not_a_member`, `tenant_archived`, `last_owner`, `forbidden`… — so your HTTP
layer decides *once* what each reveals. (Deliberately: answer both
`unknown_tenant` and `not_a_member` with 404, or an attacker enumerates your
customer list from your status codes.)

## Guarantees held as invariants, not conventions

- **A tenant always has at least one owner.** Demoting or removing the last
  owner fails with `last_owner` — checked under row locks, so two concurrent
  removals of the last two owners serialize and one loses. There is a test
  that races them.
- **Tenant scope cannot outlive its transaction.** Scoping uses
  `set_config(…, local := true)` inside a transaction pinned to one
  connection; the next borrower of that pooled connection starts unscoped.
  There is a test for that too.
- **Archived, never deleted.** A tenant's id keeps resolving in your ledger
  and your audit log after the tenant leaves; `resolve()` refuses it with
  `tenant_archived`, and `archived_at` records the first archival, not the
  latest retry.
- **Idempotent writes.** Re-creating a tenant with identical input returns
  the existing tenant; re-adding a member with the same role returns the
  existing membership. The *conflicting* retry — same slug, different name;
  same user, different role — is the one that errors, loudly and by name.

## Documentation

| Doc | What it covers |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | The module map, the two-halves rule, context propagation, and the API's design rules. |
| [docs/ISOLATION.md](docs/ISOLATION.md) | Choosing between shared-schema RLS, schema-per-tenant and database-per-tenant — mechanics, failure modes, and when to move. |
| [docs/BILLING_KIT.md](docs/BILLING_KIT.md) | Running tenant-kit and billing-kit together: one pool, one tenant id, RLS over the billing schema. |
| [sql/README.md](sql/README.md) | The shipped schema and how to apply it. |

## Requirements

Node ≥ 20.19, Postgres ≥ 14 for the RLS strategy (the directory alone works
anywhere the `SqlExecutor` interface reaches). Zero runtime dependencies;
`pg` is the test harness's, not the library's.


## The QuxKit family

Libraries you embed, not services you operate. Each kit owns one narrow thing
and composes with the rest over shared shapes — one executor interface, one
opaque tenant id, one Money type.

| Package | Stone | What it owns |
|---|---|---|
| [`@quxkit/identity-kit`](https://github.com/QuxKit/identity-kit) | gold | Accounts, argon2id credentials, revocable sessions — produces a `UserId`. |
| [`@quxkit/tenant-kit`](https://github.com/QuxKit/tenant-kit) | green | Tenant directory, request→tenant resolution, row-level-security isolation. |
| [`@quxkit/billing-kit`](https://github.com/QuxKit/billing-kit) | blue | Metering, exact pricing, a double-entry ledger, provider settlement. |
| [`@quxkit/billing-kit-adapters`](https://github.com/QuxKit/billing-kit-adapters) | blue | Payment providers beyond Stripe and Paddle. |
| [`tenant-kit-adapters`](https://github.com/QuxKit/tenant-kit-adapters) | green | Enterprise SSO, SCIM provisioning, RBAC-engine bridges. |
| [`billing-kit-components`](https://github.com/QuxKit/billing-kit-components) | blue | shadcn-compatible billing UI, per seat. |
| [`@quxkit/billing-kit-mcp`](https://github.com/QuxKit/billing-kit-mcp) | blue | Exact money math for AI assistants over MCP. |
