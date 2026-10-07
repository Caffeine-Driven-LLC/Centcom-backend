/**
 * Migration runner (B007): applies the plain SQL files of a directory in version order, each in
 * its own transaction together with its row in `schema_migrations`, under a Postgres advisory lock
 * so two instances never migrate at once. Forward-only: there are no down migrations; every file
 * ends with a `-- rollback note:` saying how to undo it by hand. `lintMigration` checks a file
 * against packages/db/CONVENTIONS.md.
 *
 * Owns: file naming, checksums, ordering, the lock and the bookkeeping table. Must not: run on
 * service boot (the CLI is a separate deploy step), log SQL, or apply anything once a check fails.
 */
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { AppError, type Logger } from '@centcom/core';
import { sql, type Kysely } from 'kysely';

/** This package's migrations: `packages/db/migrations`. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
/** `<yyyymmddhhmmss>_<snake_name>.sql`. */
export const MIGRATION_FILE_PATTERN = /^(\d{14})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;
/** The advisory lock's name, in error messages and logs. */
export const MIGRATION_LOCK_NAME = 'centcom.schema_migrations';
/** The advisory lock's 64-bit key: the first 8 bytes of SHA-256 of the name, as a signed integer. */
export const MIGRATION_LOCK_KEY = BigInt.asIntN(
  64,
  BigInt(`0x${createHash('sha256').update(MIGRATION_LOCK_NAME).digest('hex').slice(0, 16)}`),
).toString();
/** How long `migrate` waits for the lock by default. */
export const DEFAULT_LOCK_TIMEOUT_MS = 60_000;
/** How often `migrate` asks for the lock while another process holds it. */
export const DEFAULT_LOCK_POLL_MS = 250;

/** Why a migration run stopped. */
export type MigrationErrorCode =
  | 'missing_dir'
  | 'invalid_name'
  | 'duplicate_version'
  | 'unknown_target'
  | 'checksum_mismatch'
  | 'out_of_order'
  | 'lock_timeout'
  | 'migration_failed';

/** A migration run (or status read) that stopped. Messages name files, never their SQL. */
export class MigrationError extends Error {
  readonly code: MigrationErrorCode;

  constructor(code: MigrationErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

Object.defineProperty(MigrationError.prototype, 'name', {
  value: 'MigrationError',
  writable: true,
  configurable: true,
});

/** One migration file. */
export interface MigrationFile {
  /** The 14-digit `yyyymmddhhmmss` version. */
  version: string;
  /** The snake_case name. */
  name: string;
  /** `<version>_<name>.sql`. */
  fileName: string;
  /** The file's text, with CRLF line ends turned into LF and any BOM removed. */
  sql: string;
  /** `sha256:<hex>` of that text. */
  checksum: string;
}

/** One row of `schema_migrations`. */
export interface AppliedMigration {
  version: string;
  name: string;
  checksum: string;
  appliedAt: Date;
}

/** Where a database stands against a migrations directory. */
export interface MigrationStatus {
  /** Every applied migration, in version order. */
  applied: AppliedMigration[];
  /** Files not applied yet, in version order. */
  pending: MigrationFile[];
  /** Applied files whose content or name changed since: `migrate` refuses to run. */
  changed: MigrationFile[];
  /** Pending files older than the newest applied one: `migrate` refuses to run. */
  outOfOrder: MigrationFile[];
  /** Applied versions with no file: the database is ahead of this code (fine during a deploy). */
  missing: AppliedMigration[];
}

/** Options for `migrate`. */
export interface MigrateOptions {
  /** Apply up to and including this version only. */
  target?: string;
  /** How long to wait for the advisory lock; default 60 s. */
  lockTimeoutMs?: number;
  /** How often to ask for the lock; default 250 ms. */
  lockPollMs?: number;
  /** Writes one `db.migration.applied` line per migration (version, name, duration). */
  logger?: Logger;
}

/** True for a `yyyymmddhhmmss` that names a real UTC moment. */
function isTimestamp(version: string): boolean {
  const [y, mo, d, h, mi, s] = [0, 4, 6, 8, 10, 12].map((at, i) =>
    Number(version.slice(at, at + (i === 0 ? 4 : 2))),
  ) as [number, number, number, number, number, number];
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d &&
    date.getUTCHours() === h &&
    date.getUTCMinutes() === mi &&
    date.getUTCSeconds() === s
  );
}

/** The version and name of a migration file name, or undefined if it breaks the naming rule. */
export function parseMigrationFileName(
  fileName: string,
): { version: string; name: string } | undefined {
  const match = MIGRATION_FILE_PATTERN.exec(fileName);
  if (match === null) return undefined;
  const [, version = '', name = ''] = match;
  return isTimestamp(version) ? { version, name } : undefined;
}

/** A migration's text as it is checksummed and run: LF line ends, no BOM. */
const normalize = (text: string): string => text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

/** `sha256:<hex>` of a migration's text, after normalising line ends (so a checkout's CRLF does not count as an edit). */
export function migrationChecksum(text: string): string {
  return `sha256:${createHash('sha256').update(normalize(text), 'utf8').digest('hex')}`;
}

/** The `.sql` file names of `dir`, sorted; other files (a README) are ignored. */
function sqlFileNames(names: readonly string[]): string[] {
  return names.filter((n) => n.endsWith('.sql')).sort();
}

/** Checks names and versions; returns them in version order. */
function checkNames(
  fileNames: readonly string[],
): { version: string; name: string; fileName: string }[] {
  const seen = new Map<string, string>();
  return fileNames.map((fileName) => {
    const parsed = parseMigrationFileName(fileName);
    if (parsed === undefined) {
      throw new MigrationError(
        'invalid_name',
        `${fileName}: migration files are named <yyyymmddhhmmss>_<snake_name>.sql (a real UTC timestamp)`,
      );
    }
    const other = seen.get(parsed.version);
    if (other !== undefined) {
      throw new MigrationError(
        'duplicate_version',
        `${other} and ${fileName} share version ${parsed.version}`,
      );
    }
    seen.set(parsed.version, fileName);
    return { ...parsed, fileName };
  });
}

function missingDir(dir: string, err: unknown): never {
  if ((err as { code?: unknown }).code === 'ENOENT') {
    throw new MigrationError('missing_dir', `the migrations directory does not exist: ${dir}`);
  }
  throw err;
}

/** Reads and checks every migration file of `dir`, in version order. */
export async function readMigrations(dir: string): Promise<MigrationFile[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    missingDir(dir, err);
  }
  const files: MigrationFile[] = [];
  for (const entry of checkNames(sqlFileNames(names))) {
    const text = normalize(await readFile(join(dir, entry.fileName), 'utf8'));
    files.push({ ...entry, sql: text, checksum: migrationChecksum(text) });
  }
  return files;
}

/** The newest version among the migration files of `dir`, or '' when there are none. */
export function latestMigrationVersion(dir: string): string {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    missingDir(dir, err);
  }
  return checkNames(sqlFileNames(names)).at(-1)?.version ?? '';
}

/** True if the bookkeeping table exists (on the search path). */
async function hasTable<DB>(db: Kysely<DB>): Promise<boolean> {
  const { rows } = await sql<{ present: boolean }>`
    select to_regclass('schema_migrations') is not null as present
  `.execute(db);
  return rows[0]?.present === true;
}

/** The rows of `schema_migrations`, in version order; none if the table does not exist yet. */
async function appliedMigrations<DB>(db: Kysely<DB>): Promise<AppliedMigration[]> {
  if (!(await hasTable(db))) return [];
  const { rows } = await sql<{ version: string; name: string; checksum: string; applied_at: Date }>`
    select version, name, checksum, applied_at from schema_migrations order by version
  `.execute(db);
  return rows.map((r) => ({
    version: r.version,
    name: r.name,
    checksum: r.checksum,
    appliedAt: r.applied_at,
  }));
}

/** The newest applied version, or null if none (or no bookkeeping table yet). */
export async function currentMigrationVersion<DB>(db: Kysely<DB>): Promise<string | null> {
  if (!(await hasTable(db))) return null;
  const { rows } = await sql<{ version: string | null }>`
    select max(version) as version from schema_migrations
  `.execute(db);
  return rows[0]?.version ?? null;
}

/** Compares files with applied rows. */
function compare(
  files: readonly MigrationFile[],
  applied: readonly AppliedMigration[],
): MigrationStatus {
  const appliedByVersion = new Map(applied.map((row) => [row.version, row]));
  const fileVersions = new Set(files.map((f) => f.version));
  const newest = applied.at(-1)?.version;
  const pending = files.filter((f) => !appliedByVersion.has(f.version));
  return {
    applied: [...applied],
    pending,
    changed: files.filter((f) => {
      const row = appliedByVersion.get(f.version);
      return row !== undefined && (row.checksum !== f.checksum || row.name !== f.name);
    }),
    outOfOrder: newest === undefined ? [] : pending.filter((f) => f.version < newest),
    missing: applied.filter((row) => !fileVersions.has(row.version)),
  };
}

/** Where the database stands against the migration files of `dir`. Takes no lock, changes nothing. */
export async function migrationStatus<DB>(db: Kysely<DB>, dir: string): Promise<MigrationStatus> {
  const files = await readMigrations(dir);
  return compare(files, await appliedMigrations(db));
}

/** Takes the advisory lock on this connection, asking every `pollMs` until `timeoutMs` passes. */
async function takeLock<DB>(conn: Kysely<DB>, timeoutMs: number, pollMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const { rows } = await sql<{ locked: boolean }>`
      select pg_try_advisory_lock(${MIGRATION_LOCK_KEY}::bigint) as locked
    `.execute(conn);
    if (rows[0]?.locked === true) return;
    const left = deadline - performance.now();
    if (left <= 0) {
      throw new MigrationError(
        'lock_timeout',
        `could not take the migration lock (advisory lock "${MIGRATION_LOCK_NAME}", key ${MIGRATION_LOCK_KEY}) within ${Math.round(timeoutMs / 1000)} s: another migrate is running, or a session still holds it`,
      );
    }
    await sleep(Math.min(pollMs, left));
  }
}

async function releaseLock<DB>(conn: Kysely<DB>): Promise<void> {
  await sql`select pg_advisory_unlock(${MIGRATION_LOCK_KEY}::bigint)`.execute(conn);
}

/** Creates the bookkeeping table if needed. Runs under the lock: concurrent CREATE TABLE IF NOT EXISTS can fail. */
async function ensureTable<DB>(conn: Kysely<DB>): Promise<void> {
  await sql`
    create table if not exists schema_migrations (
      version text primary key check (version ~ '^[0-9]{14}$'),
      name text not null check (name ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
      checksum text not null check (checksum ~ '^sha256:[0-9a-f]{64}$'),
      applied_at timestamptz not null default now()
    )
  `.execute(conn);
}

/**
 * A driver error as one line: its message and SQLSTATE, never parameters (migrations have none).
 * A 503 from the client (the connection was lost) is described by its cause.
 */
function describe(err: unknown): string {
  if (err instanceof AppError && err.cause !== undefined) return describe(err.cause);
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? `${message} (SQLSTATE ${code})` : message;
}

/** Applies one file and records it, in one transaction: on failure neither is left behind. */
async function applyOne<DB>(conn: Kysely<DB>, file: MigrationFile, logger?: Logger): Promise<void> {
  const start = performance.now();
  try {
    await conn.transaction().execute(async (trx) => {
      // The file is trusted repository content, run as one multi-statement simple query; this is
      // the only place raw SQL runs (CONVENTIONS.md: parameterised queries everywhere else).
      await sql.raw(file.sql).execute(trx);
      await sql`
        insert into schema_migrations (version, name, checksum)
        values (${file.version}, ${file.name}, ${file.checksum})
      `.execute(trx);
    });
  } catch (err) {
    throw new MigrationError(
      'migration_failed',
      `${file.fileName} failed and was rolled back: ${describe(err)}`,
      {
        cause: err,
      },
    );
  }
  logger?.info(
    { version: file.version, name: file.name, duration_ms: Math.round(performance.now() - start) },
    'db.migration.applied',
  );
}

/**
 * Applies the pending migrations of `dir` in version order and returns the versions applied.
 *
 * - Holds the advisory lock for the whole run, so a second `migrate` waits, then finds nothing to
 *   do. Gives up with `lock_timeout` after `lockTimeoutMs` (60 s).
 * - Checks everything before applying anything: a changed applied file (`checksum_mismatch`), a
 *   pending file older than the newest applied one (`out_of_order`), bad names, an unknown target.
 * - Runs each file in its own transaction with its `schema_migrations` row; a failing file leaves
 *   no trace (`migration_failed`) and the run stops there.
 * - Applied versions with no file (the database is ahead of this code) are left alone.
 */
export async function migrate<DB>(
  db: Kysely<DB>,
  dir: string,
  opts: MigrateOptions = {},
): Promise<{ applied: string[] }> {
  const files = await readMigrations(dir);
  const { target } = opts;
  if (target !== undefined && !files.some((f) => f.version === target)) {
    throw new MigrationError('unknown_target', `no migration file has version ${target}`);
  }
  // One connection for the whole run: the advisory lock belongs to the session that took it.
  return db.connection().execute(async (conn) => {
    await takeLock(
      conn,
      opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      opts.lockPollMs ?? DEFAULT_LOCK_POLL_MS,
    );
    try {
      await ensureTable(conn);
      const status = compare(files, await appliedMigrations(conn));
      const [changed] = status.changed;
      if (changed !== undefined) {
        throw new MigrationError(
          'checksum_mismatch',
          `${changed.fileName} was changed after it was applied; migrations are never edited, add a new one`,
        );
      }
      if (status.outOfOrder.length > 0) {
        throw new MigrationError(
          'out_of_order',
          `${status.outOfOrder.map((f) => f.fileName).join(', ')} ${status.outOfOrder.length === 1 ? 'is' : 'are'} older than the newest applied migration; rename with a newer timestamp`,
        );
      }
      const applied: string[] = [];
      for (const file of status.pending) {
        if (target !== undefined && file.version > target) break;
        await applyOne(conn, file, opts.logger);
        applied.push(file.version);
      }
      return { applied };
    } finally {
      // A lost connection drops the lock with the session; the error that broke it matters more.
      await releaseLock(conn).catch(() => undefined);
    }
  });
}

/**
 * SQL text with comments, string literals and dollar-quoted bodies blanked out and quoted
 * identifiers turned into one plain word (newlines kept), so statements can be inspected without
 * matching words inside them.
 */
function blankOut(text: string): string {
  const out = text.split('');
  const blank = (from: number, to: number, fill = ' '): void => {
    for (let i = from; i < to; i++) if (out[i] !== '\n') out[i] = fill;
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '-' && next === '-') {
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? text.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && next === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        if (text[j] === '/' && text[j + 1] === '*') {
          depth += 1;
          j += 2;
        } else if (text[j] === '*' && text[j + 1] === '/') {
          depth -= 1;
          j += 2;
        } else j += 1;
      }
      blank(i, j);
      i = j;
    } else if (c === "'" || c === '"') {
      const escapes = c === "'" && /[eE]/.test(text[i - 1] ?? '') && !/\w/.test(text[i - 2] ?? '');
      let j = i + 1;
      while (j < text.length) {
        if (escapes && text[j] === '\\') j += 2;
        else if (text[j] === c && text[j + 1] === c) j += 2;
        else if (text[j] === c) break;
        else j += 1;
      }
      // A quoted identifier stays one word ("Order Items" -> xxxxxxxxxxxxx), so ALTER TABLE's
      // table name is still a single token.
      blank(i, Math.min(j + 1, text.length), c === '"' ? 'x' : ' ');
      i = j + 1;
    } else if (c === '$') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i));
      if (tag === null || /\w/.test(text[i - 1] ?? '')) {
        i += 1;
        continue;
      }
      const end = text.indexOf(tag[0], i + tag[0].length);
      const stop = end < 0 ? text.length : end + tag[0].length;
      blank(i, stop);
      i = stop;
    } else i += 1;
  }
  return out.join('');
}

/** Statements of blanked-out SQL: their text (upper case, spaces collapsed) and first line. */
function statements(blanked: string): { text: string; line: number }[] {
  const found: { text: string; line: number }[] = [];
  let start = 0;
  for (let i = 0; i <= blanked.length; i++) {
    if (i < blanked.length && blanked[i] !== ';') continue;
    const chunk = blanked.slice(start, i);
    const lead = chunk.search(/\S/);
    if (lead >= 0) {
      const line = blanked.slice(0, start + lead).split('\n').length;
      found.push({ text: chunk.trim().replace(/\s+/g, ' ').toUpperCase(), line });
    }
    start = i + 1;
  }
  return found;
}

/** Actions of an ALTER TABLE statement, split at top-level commas. */
function alterActions(statement: string): string[] {
  const body = statement.replace(/^ALTER TABLE (IF EXISTS )?(ONLY )?[^ ]+ /, '');
  const actions: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '(') depth += 1;
    else if (body[i] === ')') depth -= 1;
    else if (body[i] === ',' && depth === 0) {
      actions.push(body.slice(from, i).trim());
      from = i + 1;
    }
  }
  actions.push(body.slice(from).trim());
  return actions;
}

/** `DROP …` actions of ALTER TABLE that do not remove a column. */
const KEEPS_COLUMNS = /^DROP (CONSTRAINT|DEFAULT|NOT NULL|EXPRESSION|IDENTITY)\b/;

/** What destructive thing a statement does, if any. */
function destructive(statement: string): string | undefined {
  if (/^DROP TABLE\b/.test(statement)) return 'DROP TABLE';
  if (/^TRUNCATE\b/.test(statement)) return 'TRUNCATE';
  if (/^ALTER TABLE\b/.test(statement)) {
    const drops = alterActions(statement).filter(
      (a) => a.startsWith('DROP ') && !KEEPS_COLUMNS.test(a),
    );
    if (drops.length > 0) return 'DROP COLUMN';
  }
  return undefined;
}

const TRANSACTION_CONTROL = /^(BEGIN|START TRANSACTION|COMMIT|END|ROLLBACK|ABORT)\b/;
const CONCURRENT_INDEX = /^(CREATE (UNIQUE )?INDEX|DROP INDEX|REINDEX)\b.*\bCONCURRENTLY\b/;
const CONTRACT_MARKER = /^\s*--\s*contract\b/i;
const ROLLBACK_NOTE = /^\s*--\s*rollback note:\s*\S/i;

/**
 * Checks a migration file against CONVENTIONS.md and returns the problems found (none: `[]`):
 * the file name; the closing `-- rollback note:` comment; DROP TABLE, DROP COLUMN and TRUNCATE
 * only after a `-- contract` phase marker; no transaction control (the runner wraps every file in
 * a transaction); no `CONCURRENTLY` index builds (they cannot run in one).
 */
export function lintMigration(fileName: string, text: string): string[] {
  const problems: string[] = [];
  if (parseMigrationFileName(fileName) === undefined) {
    problems.push('the name must be <yyyymmddhhmmss>_<snake_name>.sql (a real UTC timestamp)');
  }
  const lines = normalize(text).split('\n');
  const contractLine = lines.findIndex((l) => CONTRACT_MARKER.test(l)) + 1;
  const lastCode = lines.findLastIndex((l) => l.trim() !== '' && !/^\s*--/.test(l));
  const footer = lines.slice(lastCode + 1);
  if (!footer.some((l) => ROLLBACK_NOTE.test(l))) {
    problems.push('the file must end with a "-- rollback note: …" comment saying how to undo it');
  }
  for (const statement of statements(blankOut(normalize(text)))) {
    const kind = destructive(statement.text);
    if (kind !== undefined && (contractLine === 0 || statement.line < contractLine)) {
      problems.push(
        `line ${statement.line}: ${kind} is destructive and belongs after a "-- contract" phase marker`,
      );
    }
    if (TRANSACTION_CONTROL.test(statement.text)) {
      problems.push(
        `line ${statement.line}: no transaction control; the runner wraps the file in a transaction`,
      );
    }
    if (CONCURRENT_INDEX.test(statement.text)) {
      problems.push(
        `line ${statement.line}: CONCURRENTLY cannot run inside the runner's transaction`,
      );
    }
  }
  return problems;
}
