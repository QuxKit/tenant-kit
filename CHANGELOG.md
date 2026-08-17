# Changelog

All notable changes to this project are documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
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
