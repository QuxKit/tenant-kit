# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | yes |
| < 0.1 | no |

Only the latest minor of the current major receives security fixes.

## Reporting a vulnerability

Please do **not** open a public issue for a suspected vulnerability.

- On GitHub: use the private "Report a vulnerability" form under the
  repository's Security tab (GitHub Security Advisories), which reaches the
  repository owner directly.
- On the forge (Gitea): open an issue with the title prefix `[security]` and
  the body **left empty**, and the owner (`@brett`) will contact you for
  details out of band.

You will get an acknowledgement within 72 hours and a first assessment within
7 days. We follow a **90-day coordinated disclosure** window from the initial
report: we aim to ship a fix and publish an advisory well within it, and will
credit you unless you prefer otherwise. If a fix needs longer than 90 days
we will say so and agree a date with you.

## Scope

In scope — a report about any of these is a security report:

- Tenant isolation: any way for a `scopedExecutor` / `withTenant` /
  `tenancy.db()` query to see or write another tenant's rows on a table
  protected by `tenancy.protect()`.
- Tenant scope leaking across pooled connections (a `SET LOCAL` outliving
  its transaction).
- Resolution: any path from request data (`hostname`, `path`, headers,
  claims) to a `ResolvedTenant` that skips the membership check.
- The last-owner invariant: any interleaving that leaves a tenant with zero
  owners.
- SQL injection through any parameter of the library's own queries, including
  the shipped `sql/*.sql` functions.

Out of scope:

- The host application's authentication. `UserId` is opaque; the library
  never verifies it (see README, "What it refuses to be").
- Postgres itself, `pg`, or Node.js.
- Superuser / `BYPASSRLS` connections bypassing row-level security — that is
  documented Postgres behaviour, not a library defect.
- Deployments that apply `sql/002_rls.sql` but never call `tenancy.protect()`
  on their tables.
