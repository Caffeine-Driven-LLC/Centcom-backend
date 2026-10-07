# Migrations

Plain SQL files, applied in version order by `centcom-db migrate` (see
[`../README.md`](../README.md)). Create one with `pnpm --filter @centcom/db migrate:new <snake_name>`.

- Name: `<yyyymmddhhmmss>_<snake_name>.sql`, a UTC timestamp.
- Never edit a file once it has been applied anywhere: add a new one.
- End every file with a `-- rollback note:` comment saying how to undo it by hand.
- `DROP TABLE`, `DROP COLUMN` and `TRUNCATE` only after a `-- contract` line.
- No `BEGIN`/`COMMIT` and no `CONCURRENTLY`: each file runs inside one transaction.

The rules and their reasons are in [`../CONVENTIONS.md`](../CONVENTIONS.md);
`test/runner/conventions.test.ts` checks every file here. Other files (like this one) are ignored.
