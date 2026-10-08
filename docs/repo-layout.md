# Repository layout and toolchain

Owner: lane B001. The layout follows [`plan/ARCHITECTURE.md`](../plan/ARCHITECTURE.md) §3 and
[`plan/LANE_CARD_SPEC.md`](../plan/LANE_CARD_SPEC.md); new top-level folders need an ADR.

```
apps/api          @centcom/api        Fastify REST API (/v1/*)
apps/relay        @centcom/relay      WebSocket relay (ciphertext only)
apps/worker       @centcom/worker     BullMQ jobs
apps/admin        @centcom/admin      internal admin console (B088)
packages/contracts @centcom/contracts types and validators generated from contracts/ (B003)
packages/core     @centcom/core       config, logging, errors, rbac, rate limiting, redis, email
packages/db       @centcom/db         Kysely client and SQL migrations
packages/testkit  @centcom/testkit    factories, containers, client simulator (B010, B011)
infra/            operations (B091+)
docs/             service docs
contracts/        shared with the client repo, read-only, locked by CONTRACTS.lock
plan/             the build plan (shared)
tools/plan/       plan and contract tooling (shared)
tools/repo/       repository checks owned by B001 (exact pins, layout and lint tests)
tools/lint-fixtures/  files that must fail lint/typecheck; used only by tools/repo tests
site/             public website and docs (not part of the pnpm workspace)
```

Each workspace has `package.json` (private, ESM, `engines.node >=22 <23`, public surface only
through its `exports` map), `tsconfig.json` extending `tsconfig.base.json`, and `src/index.ts`.
Tests live in `<workspace>/test/**/*.test.ts` or next to the code as `src/**/*.test.ts`.
Workspace `tsconfig.json` files build `src/` only (colocated tests excluded from `dist/`); the root
`tsconfig.test.json` type-checks every workspace's tests and scripts, plus `tools/repo`, against
source through `paths`, and `vitest.workspace.ts` resolves `@centcom/*` imports to each
workspace's `src/index.ts`, so tests type-check and run without a prior build.

A workspace that imports another lists it in `dependencies` as `workspace:*` and adds it to
`references` in its `tsconfig.json`, so `tsc -b` builds the dependency first (`@centcom/api`
references `@centcom/core` and `@centcom/contracts`; `@centcom/core` references
`@centcom/contracts`).

## Toolchain

| Tool       | Version                            | Notes                                                                         |
| ---------- | ---------------------------------- | ----------------------------------------------------------------------------- |
| Node.js    | 22 (`.node-version`)               | install fails on any other major (`engineStrict`)                             |
| pnpm       | 12.9.1 (`packageManager`)          | use Corepack: `corepack enable`                                               |
| TypeScript | 5.9.3                              | strict, ESM, `NodeNext`, `noUncheckedIndexedAccess`, project references       |
| ESLint     | 10.12.0 + typescript-eslint 8.71.1 | one root flat config; workspaces must not override it                         |
| Prettier   | 3.9.9                              | `.prettierignore` protects `contracts/`, `plan/`, `site/` and generated files |
| Vitest     | 5.0.3                              | root config is `vitest.workspace.ts` (one project per workspace, plus `repo`) |

## Root scripts

| Script                                                | What it does                                                                                                                        |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build`                                          | `tsc -b` into each `dist/`, then each package's `build:assets` (contracts: copies its generated validators)                         |
| `pnpm typecheck`                                      | `tsc -b` for sources, then `tsconfig.test.json` for tests, scripts and `tools/repo` (see below)                                     |
| `pnpm lint`                                           | ESLint, then `tools/repo/check-exact-pins.mjs` (fails on any version range)                                                         |
| `pnpm test`                                           | Vitest with v8 coverage; 80 % line coverage is the hard floor                                                                       |
| `pnpm format`                                         | Prettier, writing in place                                                                                                          |
| `pnpm contracts:gen` / `contracts:check`              | regenerate `packages/contracts/src/generated/` from `contracts/` / exit 1 if it is stale (B003; see `packages/contracts/README.md`) |
| `pnpm dev:up` / `dev:down` / `dev:reset` / `dev:seed` | the local stack: start, migrate and seed / stop / wipe and start again / seed again (B012; see `docs/dev-environment.md`)           |

`pnpm typecheck` emits into the (git-ignored) `dist/` folders like `pnpm build`: `tsc -b --noEmit`
fails once one workspace references another (TS6310, a referenced project may not disable emit).

## Rules the toolchain enforces

- **No `any`, no `console` in library code.** `console` is allowed only in `apps/*/src/main.ts`
  entrypoints and in `tools/` scripts.
- **No deep imports.** Import a workspace by its package name (`@centcom/core`), never
  `@centcom/core/src/x` or a relative path into another workspace.
- **Exact pins.** Every dependency is an exact version; `workspace:*` is the only exception.
  `saveExact: true` makes `pnpm add` pin by default.
- **No install scripts.** `ignoreScripts: true` in `pnpm-workspace.yaml` (pnpm 11+ reads settings
  only from there; `.npmrc` keeps `ignore-scripts=true` for npm and older pnpm). An exception needs
  a reviewed allow-list entry.
- **LF line endings** (`.gitattributes`): `CONTRACTS.lock` hashes raw bytes, so CRLF checkouts
  would fail `python3 tools/plan/lock.py --check`.

## Setting up a machine

```bash
corepack enable          # pnpm version comes from package.json
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

On Windows, `tools/plan/*.py` need `PYTHONUTF8=1` (they open files with the platform default
encoding) and `pip install cryptography pyyaml` for `validate_contracts.py`.
