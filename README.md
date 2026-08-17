# @quxkit/tenant-kit

<img src="https://raw.githubusercontent.com/QuxKit/quxkit-brand/main/tenant-kit/sizes/tenant-kit-128.png" width="76" align="right" alt="">

**QuxKit** · green stone · multi-tenancy

![status](https://img.shields.io/badge/status-shipped-2ea043) ![licence](https://img.shields.io/badge/licence-Apache--2.0-3fb98f) ![npm](https://img.shields.io/badge/npm-%40quxkit%2Ftenant--kit-cb3837)

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
- **Not an RBAC engine.** Three built-in roles — `owner`, `admin`, `member`
  — plus roles a tenant defines as a *name with a flat list of permission
  strings*. What `projects:write` means is your application's vocabulary;
  resources, relations and inheritance graphs belong in an engine like
  OpenFGA, which tenant-kit-adapters bridges to.
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
pnpm add @quxkit/tenant-kit pg
psql "$DATABASE_URL" -f node_modules/@quxkit/tenant-kit/sql/001_core.sql
psql "$DATABASE_URL" -f node_modules/@quxkit/tenant-kit/sql/002_rls.sql
psql "$DATABASE_URL" -f node_modules/@quxkit/tenant-kit/sql/003_invitations.sql
psql "$DATABASE_URL" -f node_modules/@quxkit/tenant-kit/sql/004_roles.sql
```

Wire it to any `pg.Pool` with the shipped adapter (`@quxkit/tenant-kit/pg`;
`pg` is an optional peer dependency, only needed for this import — the same
adapter satisfies billing-kit's executor too):

```ts
import pg from 'pg';
import { createTenancy, firstOf, fromSubdomain, fromHeader } from '@quxkit/tenant-kit';
import { pgExecutor } from '@quxkit/tenant-kit/pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const tenancy = createTenancy({ db: pgExecutor(pool) });

// Once: a tenant and its first owner, in one transaction.
const acme = await tenancy.createTenant({ slug: 'acme', name: 'Acme Corp', owner: user.id });

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

// Several statements in one request: one transaction, scoped once.
app.post('/projects', async (req, res) => {
  const project = await tenancy.withTenant(tenancy.require().tenantId, async (tx) => {
    const [row] = await tx.query('INSERT INTO projects (tenant_id, name) VALUES ($1, $2) RETURNING *',
      [tenancy.require().tenantId, req.body.name]);
    await tx.query('INSERT INTO audit (tenant_id, what) VALUES ($1, $2)',
      [tenancy.require().tenantId, 'project.created']);
    return row;
  });
  res.json(project);
});
```

`createTenant` without `owner` still works — it is the shape for imports and
migrations that bring their own membership rows. A signup flow should pass
`owner` (or call `createTenantWithOwner`, which also returns the membership),
so no committed state ever holds a tenant with zero owners.

A runnable version of this lives in [`examples/basic`](examples/basic).

Turn on isolation per table, in your own migrations:

```sql
SELECT tenancy.protect('public.projects');            -- column defaults to tenant_id
SELECT tenancy.protect('public.documents', 'org_id'); -- or name it
```

`protect` enables **forced** row-level security and installs one policy:
rows are visible iff their tenant column equals the transaction-local tenant
that `tenancy.db()` set. A query that escapes scoping sees an empty table —
the forgotten-WHERE bug degrades from a data leak to a bug report.

### Scoping shapes

| Call | Transactions | Use it for |
|---|---|---|
| `tenancy.db().query(...)` | one per statement | a single query in a handler |
| `tenancy.db().transaction(fn)` | one for `fn` | a few statements, tenant already ambient |
| `tenancy.withTenant(scope, fn)` | one for `fn`, plus the ambient context | a whole request or job; `scope` is a `ResolvedTenant` or a tenant id |
| `routedExecutor(route, { max, dispose })` | yours | database- or schema-per-tenant; an LRU-bounded cache with `close()` |

Nested `transaction()` calls inside any of these are savepoints: an inner
failure you catch rolls back only the inner work.

## Invitations

Bringing someone into a tenant is a workflow, not a directory write, and it is
the one every app rebuilds — a token table, an expiry, a revoke button, and
the bugs where a token is accepted twice or by the wrong person. tenant-kit
ships it (`sql/003_invitations.sql`):

```ts
const tenancy = createTenancy({
  db,
  invitationMailer: async ({ tenant, invitation, token }) => {
    await mail.send({ to: invitation.email, subject: `Join ${tenant.name}`,
      text: `https://app.example.com/join?token=${token}` });
  },
});

// Owner or admin, in your handler:
const { invitation, token } = await tenancy.invitations.invite({
  tenantId, email: 'dev@example.com', role: 'member', invitedBy: me.id, ttlMs: 3 * 86_400_000,
});
// `token` is returned exactly once; only its sha256 is stored.

// The invitee, after your auth layer has identified them:
const { membership } = await tenancy.invitations.accept({ token, userId: user.id });

await tenancy.invitations.list(tenantId, { state: 'pending' });
await tenancy.invitations.revoke(invitation.id);
await tenancy.invitations.resend(invitation.id);   // fresh token + expiry, old token dead
await tenancy.invitations.sweepExpired();          // housekeeping; a cron job's one line
```

What the library holds:

- **The token is a bearer credential** — random, hashed at rest, single-use
  per user. tenant-kit has no users table, so it cannot check that the
  accepting user *is* the invited email; possession is the proof, and the
  invitation binds to the first user who accepts.
- **Accepting is idempotent for that user** and `invitation_taken` for anyone
  else; expired (by time, sweep or not) is `invitation_expired`; revoked or
  superseded is `invitation_revoked`; tampered, guessed or unknown is
  `unknown_invitation` — the hash lookup does not distinguish them.
- **One pending invitation per (tenant, email).** A fresh `invite` for an
  address supersedes the old one under an advisory lock, and a partial unique
  index backs that up.
- **The mailer runs after commit.** If delivery throws, the invitation exists
  and `resend` sends it again. `memoryInvitationMailer()` collects messages
  for tests. Without a mailer, the token is still returned for you to
  deliver.

The free functions (`invite`, `acceptInvitation`, `revokeInvitation`,
`listInvitations`, `resendInvitation`, `sweepExpiredInvitations`) take
`(db, …, now)` like everything else.

## Roles and permissions

The three built-ins are implied — no row, not deletable, not redefinable —
and carry a documented default permission set. A tenant can define its own
beside them (`sql/004_roles.sql`):

```ts
await tenancy.roles.define({
  tenantId, name: 'billing', permissions: ['billing:*', 'tenant:read'], rank: 50,
});
await tenancy.setRole(tenantId, user.id, 'billing');   // custom names are assignable
await tenancy.roles.can(tenantId, user.id, 'billing:invoices:read');   // true
await tenancy.roles.require(tenantId, user.id, 'members:write');       // throws permission_denied
await tenancy.roles.permissionsOf(tenantId, user.id);                  // ['billing:*', 'tenant:read']
await tenancy.roles.list(tenantId);       // built-ins + custom, by rank
await tenancy.roles.update(tenantId, 'billing', { permissions: ['billing:read'] });
await tenancy.roles.delete(tenantId, 'billing');   // role_in_use while anyone holds it
```

Built-in defaults (`BUILTIN_ROLES`):

| Role | Rank | Permissions |
|---|---|---|
| `member` | 0 | `tenant:read`, `members:read`, `roles:read` |
| `admin` | 100 | member's, plus `tenant:write`, `members:write`, `invitations:read`, `invitations:write`, `roles:write` |
| `owner` | 200 | `*` — everything, including whatever your app defines later |

Matching is exact, `ns:*` (first segment before the colon), or `*`. Nothing
deeper: that is an RBAC engine's job.

- **`atLeast` / `requireRole` are the built-in ladder** and are unchanged; a
  custom role is not on it (`atLeast('billing', 'member')` is `false`) —
  custom roles carry permissions, not standing. Ask `can`.
- **The last-owner invariant is unchanged.** Moving the only owner to a
  custom role, however high its rank, is `last_owner`.
- **A role in use cannot vanish.** `delete` refuses with `role_in_use` (and
  the counts) while any membership or pending invitation names it — checked
  under `FOR UPDATE` on the role row, which every assignment of a custom
  role takes `FOR SHARE` on, so an assign racing a delete serializes.
- **Per tenant.** A role defined in one tenant is `unknown_role` in another.

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

## Errors

Every failure is a `TenancyError` whose `failure.code` is one of:

| Code | Raised by | Meaning |
|---|---|---|
| `invalid_slug` | `createTenant`, `validateSlug` | not a DNS label, or reserved (`reason` says which) |
| `invalid_tenant` | `createTenant`, `renameTenant`, `addMember`, `invitations.invite` | an empty `name`, `userId`, `owner`, `invitedBy`, a bad `email` or `ttlMs` (`field`) |
| `slug_taken` | `createTenant`, `createTenantWithOwner` | the slug exists with a different name/state — or, on the owner path, without you as an owner (`detail`) |
| `unknown_tenant` | lookups, `authorize` | no tenant for `ref` |
| `tenant_archived` | `authorize`, `resolve` | the tenant exists but is archived |
| `invalid_role` | `addMember`, `setRole`, `invitations.invite`, `roles.*` | malformed name; or (`roles.*`) reserved, or defined differently (`reason`) |
| `unknown_role` | `addMember`, `setRole`, `invitations.invite`, `roles.*` | not built-in and not defined for this tenant |
| `role_in_use` | `roles.delete` | `members` / `invitations` still name it |
| `permission_denied` | `roles.require` | the user's role does not cover `permission` |
| `not_a_member` | `getMembership`, `setRole`, `authorize` | no membership row |
| `already_a_member` | `addMember` | the user is a member with a different role |
| `last_owner` | `setRole`, `removeMember` | the change would leave zero owners |
| `forbidden` | `requireRole` | `have` does not cover `need` on the built-in ladder |
| `unknown_invitation` | `invitations.*` | no invitation for the token or id (tampered tokens land here too) |
| `invitation_expired` | `invitations.accept` | the token has timed out (`expiresAt`) |
| `invitation_revoked` | `invitations.accept`, `.resend` | revoked, or superseded by a newer invite |
| `invitation_taken` | `invitations.accept`, `.revoke`, `.resend` | already accepted by `acceptedBy`, who is not you |
| `no_tenant_claim` | `resolve` | no extractor claimed anything |
| `no_tenant_context` | `require`, `db()`, `scopedExecutor` | outside `run`, or an empty tenant id |

Use `TenancyError.hasCode(e, 'last_owner')` to narrow; never parse `.message`.

## Guarantees held as invariants, not conventions

- **A tenant always has at least one owner.** Demoting or removing the last
  owner fails with `last_owner` — checked under row locks taken in one
  statement, in one order, so two concurrent removals of the last two owners
  serialize and one loses with `last_owner` (not a deadlock). There is a test
  that forces the interleaving. And `createTenant({ owner })` inserts the
  tenant and its owner in one transaction, so the invariant holds from the
  first commit.
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
`pg` is an optional peer, resolved only when you import
`@quxkit/tenant-kit/pg`.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) (dev setup, the test database, the
issue → branch → PR rule) and [SECURITY.md](SECURITY.md) (what is in scope,
how to report privately). Changes are listed in [CHANGELOG.md](CHANGELOG.md).


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
