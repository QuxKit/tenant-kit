# Changelog

All notable changes to this project are documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Invitations (`sql/003_invitations.sql`, `tenancy.invitations.*` and the
  free functions `invite` / `acceptInvitation` / `revokeInvitation` /
  `listInvitations` / `resendInvitation` / `sweepExpiredInvitations`):
  tokens are random, returned once and stored as sha256; `accept` is
  idempotent for the accepting user and typed for everyone else
  (`invitation_taken`, `invitation_expired`, `invitation_revoked`,
  `unknown_invitation`); one pending invitation per (tenant, email);
  `InvitationMailer` seam (`invitationMailer` option) with
  `memoryInvitationMailer()` for tests; expiry sweep.
- Custom roles and permissions (`sql/004_roles.sql`, `tenancy.roles.*` and
  `defineRole` / `updateRole` / `deleteRole` / `getRole` / `listRoles` /
  `can` / `permissionsOf` / `requirePermission` / `hasPermission`): a role is
  a per-tenant name with `permissions text[]` and a `rank`; the built-ins
  are implied, with a documented default permission set (`BUILTIN_ROLES`);
  `addMember` / `setRole` / `invite` accept custom names (validated under
  a share lock on the role row); `deleteRole` refuses `role_in_use`; typed
  `unknown_role`, `role_in_use`, `permission_denied`; `invalid_role` gains
  an optional `reason`. `Role` is now `BuiltinRole | string`; `atLeast` /
  `requireRole` are the built-in ladder (a custom role answers `false`); the
  last-owner invariant is unchanged. `isRole` is deprecated in favour of
  `isBuiltinRole`.
- `tenancy.coverage()` / `coverage(db, { columns, ignoreSchemas })`: lists
  every table outside `tenancy.*` with a tenant column, split into
  `protected` (RLS enabled + forced + at least one policy) and
  `unprotected` (with `gaps`: `rls_disabled`, `rls_not_forced`,
  `no_policy`). Works as the non-superuser app role.
- Lifecycle events outbox and audit log (`sql/005_events.sql`):
  `tenancy.events` is written in the same transaction as every mutation
  (`tenant_*`, `member_*`, `invitation_*`, `role_*`; no-ops write nothing);
  `tenancy.events.poll({ after, limit })` / `.ack(ids)` / `.list(tenantId)`.
  `tenancy.audit_log` (actor, action, target, at, metadata) is written by
  every mutating call when an actor is known: `tenancy.as(actor, metadata?)`
  binds one explicitly, the ambient `ResolvedTenant`'s user is used inside
  `run` / `withTenant`, `invite` attributes to `invitedBy` and `accept` to
  the acceptor; `tenancy.audit.list(tenantId, { limit, before, actor })`.
  Free functions take a trailing `MutationMeta`; `record()` is exported for
  host mutations that want to write into the same outbox.
- `@quxkit/tenant-kit/pg`: the shipped `pg.Pool` adapter (`pgExecutor`), with
  `pg` as an optional peer dependency. Nested `transaction()` calls use
  `SAVEPOINT` / `ROLLBACK TO SAVEPOINT`, so an inner failure rolls back only
  its own work.
- `createTenant({ slug, name, owner })` / `createTenantWithOwner(...)`: insert
  the tenant and its first owner membership in one transaction. The
  owner-less form remains for imports and migrations.
- `Tenancy.withTenant(scope, fn)`: one transaction, one `SET LOCAL`, many
  statements — the per-request shape.
- `routedExecutor(route, { max, dispose })`: an LRU-bounded cache with
  `close()`, which disposes every cached executor.
- `examples/basic`: a runnable end-to-end example.
- CI on GitHub Actions (Node 20/22 matrix, Postgres 16 service) and Gitea;
  release workflow (`v*` tags, `npm publish --provenance`); dependabot;
  CODEOWNERS; `CONTRIBUTING.md`; `SECURITY.md`.
- Biome (`pnpm lint`, `pnpm format`) and c8 coverage (`pnpm test:coverage`)
  with thresholds.
- Test harness honours `REQUIRE_DB=1` (fail instead of skip when the database
  is unreachable); public-surface and harness sanity tests.

### Changed
- `setRole`, `removeMember`, `renameTenant`, `restoreTenant`, `deleteRole`
  (free functions) now take `now: Date` — every mutation carries a
  timestamp for its event. The instance methods are unchanged.
- `tenancy.memberships.role` is no longer CHECK-constrained to the three
  built-in names (`004_roles.sql` drops it); the library validates roles
  against `tenancy.roles`.
- `scopedExecutor`'s nested `transaction()` uses savepoints instead of
  flattening into the outer transaction.
- Test files use one shared harness (`test/harness.ts`); the per-test skip
  sites are gone.
- `prepublishOnly` runs lint, typecheck, build and test.

### Fixed
- `removeMember` / `setRole` lock a tenant's owner rows in one deterministic
  order, so two concurrent removals of the last two owners resolve to one
  success and one `last_owner` instead of a deadlock (`40P01`).

### Security
- `SECURITY.md` documents the disclosure process and what is in scope.

## [0.1.0] - 2026-08-14

### Added
- Initial release: tenant directory (create/get/list/rename/archive/restore),
  memberships with the last-owner invariant, request resolution
  (`fromSubdomain`, `fromHeader`, `fromPath`, `fromClaim`, `firstOf`,
  `resolve`, `authorize`), `TenantScope` context, `scopedExecutor` /
  `routedExecutor` isolation, and the `tenancy` SQL schema with
  `tenancy.protect()`.
