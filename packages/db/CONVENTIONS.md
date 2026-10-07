# Database conventions

How every lane writes schema and queries for Postgres 16. `test/runner/conventions.test.ts`
checks the migration rules on every file in `migrations/`; reviewers check the rest.

## Tables and columns

- **Names:** `snake_case`, tables in the plural (`users`, `session_members`), columns in the
  singular. No quoted identifiers, no abbreviations a reader would have to guess.
- **Primary keys:** `id text primary key` holding a CT-IDS prefixed ULID, with a CHECK on its
  prefix and shape, so a wrong id cannot be stored:

  ```sql
  id text primary key check (id ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$')
  ```

  Ids are created by the application (`newId('usr')` from `@centcom/contracts`), never by the
  database. A foreign key column is `<entity>_id text`, for example `user_id`.

- **Timestamps:** `timestamptz`, always UTC on the wire (CT-IDS). Every table has
  `created_at timestamptz not null default now()`; tables whose rows change also have
  `updated_at timestamptz not null default now()`, which the repository sets in the same `UPDATE`
  (`updated_at = now()`). No triggers: behaviour stays visible in the code that causes it.
- **Text:** `text` with a CHECK on its length (`check (char_length(name) between 1 and 40)`), not
  `varchar(n)`. E-mail addresses are `citext` (B008).
- **Enumerations:** `text` with a CHECK listing the values
  (`check (role in ('owner', 'admin', 'member'))`), never a Postgres `ENUM`: CT-VER lets enums grow,
  and an `ENUM` value cannot be removed.
- **Money:** integer minor units (`bigint`) plus a `currency text` column (CT-IDS). Never floats.
- **JSON:** `jsonb`, only for opaque settings the application validates; anything queried gets a
  column of its own.
- **Booleans:** `boolean not null default …`. Nullable booleans need a reason.

## Deleting

- **Soft delete** (`deleted_at timestamptz`, null while the row is live) only where the product
  needs undo or a retention window. Queries filter on `deleted_at is null`; unique constraints
  become partial unique indexes `where deleted_at is null`.
- **Hard delete** is a retention job's work (B090), in batches.
- **Foreign keys** are always declared, `on delete restrict` unless the card says otherwise.
  Never `on delete cascade` from users or workspaces into history or audit tables.

## Indexes and constraints

- Index names: `<table>_<columns>_idx`; unique ones `<table>_<columns>_key`. Foreign keys and
  checks keep the names Postgres gives them (`<table>_<column>_fkey`, `<table>_<column>_check`).
- Index the foreign key columns that queries look up by.

## Migrations

- **One file per change**, `migrations/<yyyymmddhhmmss>_<snake_name>.sql`, a UTC timestamp (create
  one with `pnpm --filter @centcom/db migrate:new <name>`). Timestamps keep parallel lanes from
  colliding; the runner refuses a file older than the newest applied one, so rename yours with a
  newer timestamp if another lane's lands first.
- **Never edit an applied file.** The runner keeps each file's SHA-256 and refuses to run when
  one changed. Fix forward with a new file.
- **Forward-only.** There are no down migrations. Every file ends with a `-- rollback note:`
  comment saying how to undo it by hand, or why nothing is needed.
- **Expand, migrate, contract.** A release must work with the schema of the release before it:
  1. _expand:_ add tables, nullable columns, columns with defaults, indexes;
  2. _migrate:_ the code writes both shapes, a job backfills;
  3. _contract:_ in a later release, once no running code uses the old shape, drop it.

  Destructive statements (`DROP TABLE`, `DROP COLUMN`, including `ALTER TABLE … DROP x`, and
  `TRUNCATE`) are allowed only after a `-- contract` line in the file, which says this file is a
  contract step. Renaming a column or table is an expand-and-contract too, never one statement.

- **One transaction per file.** The runner wraps each file in a transaction with its
  `schema_migrations` row, so a failing file leaves nothing behind. Therefore no `BEGIN`,
  `COMMIT` or `ROLLBACK`, and no `CREATE INDEX CONCURRENTLY` (it cannot run in a transaction; an
  index on a large, busy table needs its own procedure, B092).
- **Keep locks short** on tables in use: start such a file with `set local lock_timeout = '5s';`
  so a migration that cannot get its lock fails instead of queueing every query behind it.
- **No secrets and no work content** in any column: no message text, file paths or branch names
  (GUIDELINES §5.3). Every stored field has a retention rule (B090).

## Queries

- **Parameterised only:** Kysely's query builder, or its `sql` tagged template for what the
  builder cannot express (every interpolated value becomes a parameter). Never `sql.raw` or
  string-built SQL; the migration runner is the one place raw SQL runs, and only from files in
  this repository.
- **Transactions:** `withTransaction(db, fn)`. Pass the transaction (`trx`) to the code that
  needs it; nesting is refused. `fn` may run more than once after a serialization failure, so
  keep side effects outside the database (e-mail, publishing) out of it.
- **Types:** each schema lane describes its tables as Kysely interfaces in
  `src/schema/<area>.ts` (B008: `CoreDatabase`), with `ColumnType`/`Generated` for columns the
  database fills.
- **Never log** SQL parameters, rows or the connection string.
