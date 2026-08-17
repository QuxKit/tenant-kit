# Contributing to @quxkit/tenant-kit

Thanks for looking. This is a small library with a narrow scope (see the
README's "What it refuses to be"); contributions that keep it narrow are the
easiest to land.

## Development setup

```sh
git clone https://github.com/QuxKit/tenant-kit.git
cd tenant-kit
pnpm install
```

Node >= 20.19 and pnpm are required (`corepack enable` gets you pnpm).

### The test database

Most tests run against a real Postgres. Create the database once:

```sh
createdb tenant_kit_test
```

The harness connects to `postgres://localhost:5432/tenant_kit_test` by
default; set `TENANT_KIT_TEST_DATABASE_URL` to point elsewhere. It rebuilds
the `tenancy` schema from `sql/` on every run and creates a non-superuser
role (`tenant_kit_test_app`) for the row-level-security tests, so the account
you connect with needs `CREATEROLE`.

Without a reachable database the DB suites are **skipped** with a reason.
Set `REQUIRE_DB=1` to make that a failure instead (CI does).

### Scripts

| Script | What it does |
|---|---|
| `pnpm lint` | Biome: lint + format check |
| `pnpm format` | Biome: write formatting |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm build` | tsup: ESM + CJS + d.ts into `dist/` |
| `pnpm test` | every `test/**/*.test.ts`, DB suites included |
| `pnpm test:coverage` | the same under c8, with thresholds |

## Workflow

1. **Open an issue first** describing the problem (not the solution). Every
   change — feature, fix, docs — traces back to an issue.
2. **Branch from `main`**, named `<type>/<issue>-<short-slug>`, e.g.
   `fix/12-savepoint-rollback`.
3. **Commit in logical steps** with Conventional Commit subjects
   (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `ci:`, `style:`, `refactor:`).
   Explain *why* in the body when it is not obvious from the diff.
4. **Before pushing**, run `pnpm lint && pnpm typecheck && pnpm build && pnpm test`
   with the test database up. CI runs the same set.
5. **Open a pull request** against `main`. Nothing lands on `main` directly.
   The PR body should start with `Closes #<issue>`.

## What a good change looks like

- A behavioural fix ships with a test that fails before and passes after.
- A new error is a new member of `TenancyFailure` in `src/errors.ts`, and is
  mentioned in the README's errors section.
- Public API changes are additive; breaking changes wait for a major.
- No new runtime dependencies. `pg` is an optional peer, only for `./pg`.
- Diagrams in the README are ASCII; mermaid lives in `docs/DIAGRAMS.md`.
