# @centcom/db

The shared database package (lane B007): a pooled Postgres client (Kysely over `pg`), a
forward-only migration runner and its `centcom-db` CLI, transactions that retry serialization
failures, and the health probe behind `/readyz` (CT-STATUS). Schema work follows
[`CONVENTIONS.md`](CONVENTIONS.md).

```ts
import { baseConfig } from '@centcom/core';
import { createDb, healthCheck, withTransaction } from '@centcom/db';

const config = baseConfig(); // in apps/*/src/main.ts
// CoreDatabase: the table types of B008's schema
const db = createDb<CoreDatabase>({ url: config.databaseUrl.reveal(), applicationName: 'api' });

await withTransaction(db, async (trx) => {
  await trx.insertInto('workspaces').values(workspace).execute();
  await trx.insertInto('memberships').values(owner).execute();
});

const { ok, migrationsAtExpected } = await healthCheck(db); // for /readyz
```

## Public interface

| Export                                                                  | What it is                                                                                                                                                                             |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createDb<DB>(cfg)`, `closeDb(db)`                                      | A Kysely instance over a new `pg` pool (settings below); closes it. Lazy: nothing connects until the first query                                                                       |
| `poolStats(db)`                                                         | `{max, total, idle, waiting}` of the pool, for a saturation gauge                                                                                                                      |
| `migrate(db, dir, {target?, lockTimeoutMs?, logger?})`                  | Applies the pending migrations of `dir`; returns `{applied: string[]}` (versions)                                                                                                      |
| `migrationStatus(db, dir)`                                              | `{applied, pending, changed, outOfOrder, missing}`; takes no lock, changes nothing                                                                                                     |
| `readMigrations(dir)`, `lintMigration(fileName, text)`                  | The checked files of a directory; the CONVENTIONS checks for one file (`[]` when it is fine)                                                                                           |
| `withTransaction(db, fn, {isolation?})`                                 | Runs `fn(trx)` in a transaction, retrying a serialization failure up to 3 times                                                                                                        |
| `expectedMigrationVersion(dir?)`, `healthCheck(db, opts?)`              | The newest migration version of a build; `{ok, migrationsAtExpected, expectedVersion, currentVersion}` within a 2 s timeout                                                            |
| `MigrationError`, `isConnectionError`, `isSerializationFailure`         | Typed runner errors (`code`: `checksum_mismatch`, `lock_timeout`, `migration_failed`, ...) and error classifiers                                                                       |
| `Database`, `SchemaMigrationsTable`, `DbConfig`, ...                    | Types; `Database` holds the tables this package owns (`schema_migrations`); schema lanes pass their own database type to `createDb<DB>()`                                              |
| `createUserRepo(db)`, `User`, `NewUser`, `ProfilePatch`, `isEmailTaken` | The users repository (B013): `create`, `findById`, `findByEmail` (case-insensitive), `updateProfile`, `markDeletionRequested`, `markDeleted`, `listByIds`; selects only `USER_COLUMNS` |
| `createMembershipRepo(db)`                                              | The RBAC `MembershipReader` (B021): a member's workspace role (none in a soft-deleted workspace) and most powerful live session seat; wrap it in `cachedMembershipReader`              |

## Client

| Setting (`DbConfig`)         | Default | What it does                                                                      |
| ---------------------------- | ------- | --------------------------------------------------------------------------------- |
| `url`                        | -       | Postgres URL (`baseConfig().databaseUrl.reveal()`). Never logged or put in errors |
| `poolMax`                    | 10      | Most open connections                                                             |
| `idleTimeoutMs`              | 30 000  | An idle connection is closed after this long                                      |
| `connectTimeoutMs`           | 5 000   | The most a query waits for a connection, new or from a full pool                  |
| `statementTimeoutMs`         | 10 000  | Postgres `statement_timeout`: a longer statement is cancelled (0: none)           |
| `idleInTransactionTimeoutMs` | 15 000  | Postgres `idle_in_transaction_session_timeout`                                    |
| `applicationName`            | -       | Shown in `pg_stat_activity`                                                       |
| `metrics`, `logger`          | no-op   | See below                                                                         |

The entrypoint fills these from its configuration; the URL comes from `baseConfig()` (B004),
which enforces TLS (`sslmode`) in production.

**Failure modes.**

- **Database unreachable:** `createDb` still succeeds; queries fail with a 503
  `AppError('service_unavailable')` from `@centcom/core` (B006) whose `cause` keeps only the
  driver's message and code (`connect ECONNREFUSED 10.0.0.5:5432`), never the URL.
- **Pool exhausted:** a query waits at most `connectTimeoutMs` for a free connection, then fails
  with the same 503.
- **Connection lost:** a connection that dies idle in the pool is dropped and replaced; one that
  dies while in use fails its next query with a 503 and is closed on release. Either way the
  process survives (`pg` would otherwise raise an unhandled `'error'`), and a
  `db.connection_lost` warning is logged.
- **Statement timeout:** Postgres cancels the statement with SQLSTATE 57014, which reaches the
  caller as the driver's error: it is a query problem, not an outage.

**Metrics** (through the `Metrics` interface from `@centcom/core`): `db_pool_acquire_seconds`
(histogram), `db_pool_timeouts_total`, `db_connection_errors_total`, `db_connections_lost_total`;
`poolStats(db)` gives the numbers for a saturation gauge.

## Migrations

Plain SQL files in [`migrations/`](migrations/README.md), named
`<yyyymmddhhmmss>_<snake_name>.sql`. Run them as their own deploy step, never on service boot:

```bash
pnpm --filter @centcom/db build
pnpm --filter @centcom/db migrate                  # centcom-db migrate
pnpm --filter @centcom/db migrate:status           # centcom-db status
pnpm --filter @centcom/db migrate:new add_widgets  # centcom-db new add_widgets
```

The CLI reads `DATABASE_URL`, `NODE_ENV` and `ALLOW_INSECURE_BACKENDS` (the production TLS rule of
`baseConfig`), never prints the URL, and exits 0 when done, 1 on failure, 2 on a usage error.
`migrate` takes `--target <version>`; every command takes `--dir <path>`.

What `migrate` guarantees:

- **One runner at a time.** It holds a Postgres advisory lock (`centcom.schema_migrations`, key
  `MIGRATION_LOCK_KEY`) for the whole run on one connection. A second runner waits, then finds
  nothing to do; after 60 s it gives up with `lock_timeout`, naming the lock. A crashed runner's
  lock goes with its session.
- **Checks before changes.** Bad names, duplicate versions, an applied file that changed
  (`checksum_mismatch`, SHA-256 of the text with LF line ends) or a pending file older than the
  newest applied one (`out_of_order`) stop the run before anything is applied.
- **Atomic files.** Each file runs in its own transaction with its `schema_migrations` row
  (`version, name, checksum, applied_at`): a failing file leaves no change and no row
  (`migration_failed`), and the run stops there.
- **Newer databases are fine.** Applied versions with no file (the database is ahead, as during
  a deploy of the previous release) are left alone; `healthCheck` counts them as ready.

## Transactions

`withTransaction(db, fn, { isolation })` commits when `fn` resolves and rolls back when it throws.
A serialization failure (SQLSTATE 40001) from `fn` or the commit runs `fn` again, up to 3 more
times with a short random pause, then the error is rethrown; no other error is retried. Passing a
transaction, or opening one inside another, throws a `TypeError`: pass `trx` on instead.

## Core schema (B008)

[`migrations/20260101000000_core_schema.sql`](migrations/20260101000000_core_schema.sql) creates
the tables every identity, workspace and session lane builds on; `src/schema/core.ts` describes
them for Kysely (`createDb<CoreDatabase>(...)`). Enumerated columns use the contract's types
(`Api.Role`, `Api.SessionRole`, ...), so a value the contract does not know does not compile.

| Table             | Holds                                                    | Rules beyond the column types                                                                                      |
| ----------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `users`           | accounts                                                 | `usr_` id; e-mail `citext`, unique ignoring case, at most 254; display name 1-40; BCP 47 `locale` (`en`); `status` |
| `devices`         | each signed-in CLI, TUI or browser, with its public keys | `dev_` id; name 1-80; `platform` from CT-API-ACCOUNTS; 43-character base64url keys; fingerprint `ABCD-EFGH-IJKL`   |
| `workspaces`      | team spaces, soft-deleted through `deleted_at`           | `wsp_` id; name 1-60; slug `[a-z0-9-]{3,40}`, unique even among deleted ones; `settings` a JSON object; `version`  |
| `memberships`     | a user's role in a workspace                             | `mem_` id; CT-RBAC role; one per (workspace, user)                                                                 |
| `sessions`        | command-post metadata (never content)                    | `ses_` id; name 1-80; state `pending`, `live`, `paused`, `ended` or `expired`; region such as `eu`                 |
| `session_members` | who sits in which slot of a session, on which device     | `mem_` id; `host`, `editor` or `viewer`; slot 0 or more, unique per session                                        |

- **Nothing cascades from users.** Deleting a user fails while a device, membership, workspace
  or session refers to it; account deletion is a job (B026).
- **Indexes:** `devices.user_id`, `memberships.user_id`, `sessions.workspace_id`, plus the unique
  ones on `users.email`, `workspaces.slug`, `memberships (workspace_id, user_id)` (which also serves
  lookups by workspace) and `session_members (session_id, slot)`.
- **citext:** the migration creates the extension; it needs CREATE on the database (the owner has
  it) and fails with "permission denied to create extension" otherwise.
- A later lane that needs another column adds its own migration; this file never changes.

<<<<<<< HEAD
## Refresh tokens (B017)

[`migrations/20260102000000_refresh_tokens.sql`](migrations/20260102000000_refresh_tokens.sql)
creates `refresh_tokens` for the API's token service; `src/schema/refresh-tokens.ts` types it
(`TokenDatabase` = `CoreDatabase` plus this table).

- **No token is stored.** A row is keyed by the token's SHA-256 (`token_hash`, hex), the only
  thing a presented token is looked up by. Rows are never exposed, so they have no CT-IDS id; the
  `family_id` that every rotation of one sign-in shares is 128 random bits (hex).
- **Lifetimes:** `expires_at` (30 days after the rotation that issued the token, sliding) never
  passes `absolute_expires_at` (180 days after the family's first token): a CHECK holds it.
- **References:** `user_id`, `device_id`, `workspace_id` and `parent_hash` (the token this one
  replaced), all `on delete restrict`; indexes on `family_id`, `user_id` and `device_id`.
- **Retention:** the purge job (B090) removes rows past `absolute_expires_at`.

The core schema tests stop the runner at the core version (`target`), so later migrations such
as this one do not change what they check.
=======
## Identities (B015)

[`migrations/20260102000400_identities.sql`](migrations/20260102000400_identities.sql) creates
`identities(provider, subject, user_id, created_at)` for social login.
`src/schema/identities.ts` types it (`SocialDatabase` = `CoreDatabase` plus this table).

- **Contents:** only the provider (`github`, `google`) and its stable account id (`subject`) per
  user. No provider token, code or e-mail address.
- **Key:** the natural pair `(provider, subject)`, so a second link of one account fails with
  `identities_pkey`; the rows are never exposed, so there is no CT-IDS id.
- **`user_id`:** `on delete restrict`, indexed.

The core schema tests stop the runner at the core version (`target`), so later migrations do not
change what they check.

## Invites (B029)

[`migrations/20260102000800_invites.sql`](migrations/20260102000800_invites.sql) creates
`invites`; `src/schema/invites.ts` types it (`InviteDatabase` = `CoreDatabase` plus this table),
and `createInviteStore(db)` (`src/repos/invites.ts`) is its SQL.

- **Tokens:** only `token_hash` (sha256, 32 bytes, unique) is stored; invites are found by it.
- **One pending invite per address per workspace:** a partial unique index on
  `(workspace_id, email)`; an insert that meets it writes nothing (`insert` returns null).
- **Status** comes from `accepted_at`, `revoked_at`, `expired_at` and `expires_at`
  (`inviteStatus`); `sweep(now)` sets `expired_at` on lapsed invites.
- **Key bundles:** opaque `key_bundle` bytes (48 to 12 288) with their `key_bundle_expires_at`;
  `takeKeyBundle` hands one out once, while it lasts; revocation, expiry and the sweep drop them.
- **Foreign keys** restrict: a purged workspace's invites go through `deleteForWorkspace` (the
  worker's `invites` purge hook) before B027's purge; deleting a user who created or accepted an
  invite is refused (B026's job).
>>>>>>> origin/main

## Tests

`test/runner/` holds the tests of the client and the runner, `test/schema/` those of the schemas.
The real-Postgres cases run when `DATABASE_URL` is set (CI's
`integration` job uses a Postgres 16 service container; locally, any server where the user may
`CREATE DATABASE`); each test gets a throwaway database, dropped afterwards. Without it they are
skipped, and the same cases still run against an in-memory fake dialect (`fake-postgres.ts`) and,
for the driver paths, a minimal wire-protocol stub (`wire-server.ts`).

- **`runner.test.ts`:** ordering and idempotence, checksum protection, two concurrent runners,
  atomic failure, the lock timeout, targets, out-of-order files, status
- **`tx.test.ts`:** commit, rollback, retries on 40001 (forced by the server), no retry for other
  errors, isolation levels, nesting
- **`client.test.ts`:** settings, lazy connection, unreachable and silent servers, a full pool,
  statement timeout, session settings, lost connections, metrics
- **`health.test.ts`:** behind, at and ahead of the expected version, no or unreadable migrations,
  unreachable and silent databases
- **`cli.test.ts`:** usage, `new`, `migrate`, `status`, configuration and connection errors
- **`files.test.ts`**, **`conventions.test.ts`:** naming, checksums, ordering, and the CONVENTIONS
  checks on every file in `migrations/`
- **`schema/core.test.ts`:** the core schema: six tables and an idempotent re-run, the constraint
  matrix, the Kysely types against `information_schema` (and, through tsc, against a sample query),
  and the citext permission failure
