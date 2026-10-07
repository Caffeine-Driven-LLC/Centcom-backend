#!/usr/bin/env node
/**
 * `centcom-db` (B007): the migration CLI. It runs as its own deploy step, never on service boot.
 *
 *   centcom-db migrate [--target <version>] [--dir <path>]   apply the pending migrations
 *   centcom-db status [--dir <path>]                          list applied, pending and changed files
 *   centcom-db new <snake_name> [--dir <path>]                create an empty migration file
 *
 * `migrate` and `status` read DATABASE_URL, NODE_ENV and ALLOW_INSECURE_BACKENDS through the config
 * loader, with the production TLS rule of `baseConfig`. Exit codes: 0 done, 1 failed, 2 usage.
 *
 * Owns: argument parsing, output and exit codes. Must not: print the connection string or SQL.
 */
import { realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  AppError,
  baseEnvSchema,
  ConfigError,
  defineConfig,
  type Env,
  type Secret,
} from '@centcom/core';
import type { Kysely } from 'kysely';
import { closeDb, createDb, type Database } from './client.js';
import {
  MIGRATIONS_DIR,
  MigrationError,
  migrate,
  migrationStatus,
  parseMigrationFileName,
} from './migrate.js';

/** `statement_timeout` of the CLI's connection: migrations may run long, but not forever. */
export const MIGRATION_STATEMENT_TIMEOUT_MS = 30 * 60_000;
/** Exit codes. */
export const EXIT = Object.freeze({ ok: 0, failed: 1, usage: 2 });

export const USAGE = `Usage:
  centcom-db migrate [--target <version>] [--dir <path>]   apply the pending migrations
  centcom-db status [--dir <path>]                          list applied, pending and changed files
  centcom-db new <snake_name> [--dir <path>]                create an empty migration file

migrate and status read DATABASE_URL. The default directory is packages/db/migrations.
`;

/** sslmode values that require TLS to Postgres. */
const TLS_SSLMODES = new Set(['require', 'verify-ca', 'verify-full']);

/** The keys the CLI reads, with the production TLS rule `baseConfig` applies to DATABASE_URL. */
const cliEnvSchema = baseEnvSchema
  .pick({ NODE_ENV: true, DATABASE_URL: true, ALLOW_INSECURE_BACKENDS: true })
  .refine(
    (v) => {
      if (v.NODE_ENV !== 'production' || v.ALLOW_INSECURE_BACKENDS) return true;
      const modes = new URL(v.DATABASE_URL.reveal()).searchParams.getAll('sslmode');
      return modes.length === 1 && TLS_SSLMODES.has(modes[0] ?? '');
    },
    {
      path: ['DATABASE_URL'],
      message:
        'must set exactly one sslmode, require (or verify-ca, verify-full), in production; ALLOW_INSECURE_BACKENDS=1 overrides',
    },
  );

/**
 * The CLI's configuration from `env` (default `process.env`, read by the config loader): the
 * keys `baseConfig` would check for DATABASE_URL, nothing else. Throws ConfigError.
 */
export function cliConfig(env?: Env): { databaseUrl: Secret<string> } {
  return { databaseUrl: defineConfig(cliEnvSchema, env).DATABASE_URL };
}

/** What the CLI reads and writes; tests replace parts of it. */
export interface CliDeps {
  out(text: string): void;
  err(text: string): void;
  /** DATABASE_URL from the environment; throws ConfigError. */
  databaseUrl(): string;
  /** Opens the database to work on. */
  openDb(url: string): Kysely<Database>;
  /** The current time, for `new`. */
  now(): Date;
  /** The migrations directory when `--dir` is not given. */
  dir: string;
}

const defaultDeps = (): CliDeps => ({
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  databaseUrl: () => cliConfig().databaseUrl.reveal(),
  openDb: (url) =>
    createDb<Database>({
      url,
      poolMax: 1,
      statementTimeoutMs: MIGRATION_STATEMENT_TIMEOUT_MS,
      applicationName: 'centcom-db',
    }),
  now: () => new Date(),
  dir: MIGRATIONS_DIR,
});

type Command = 'migrate' | 'status' | 'new' | 'help';

interface Parsed {
  command: Command;
  name?: string;
  target?: string;
  dir?: string;
}

const VALUE_FLAGS = new Set(['--dir', '--target']);

/** Parses argv (without node and the script), or says what is wrong with it. */
function parseArgs(argv: readonly string[]): Parsed | { error: string } {
  const [command, ...rest] = argv;
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    return { command: 'help' };
  }
  if (command !== 'migrate' && command !== 'status' && command !== 'new') {
    return { error: `unknown command "${command}"` };
  }
  const parsed: Parsed = { command };
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? '';
    const [flag = '', inline] = arg.startsWith('--') ? arg.split(/=(.*)/s, 2) : [arg];
    if (!VALUE_FLAGS.has(flag)) {
      if (arg.startsWith('-')) return { error: `unknown option "${arg}"` };
      positional.push(arg);
      continue;
    }
    const value = inline ?? rest[++i];
    if (value === undefined || value === '') return { error: `${flag} needs a value` };
    if (flag === '--dir') parsed.dir = value;
    else if (command === 'migrate') parsed.target = value;
    else return { error: `--target only applies to migrate` };
  }
  if (command === 'new') {
    if (positional.length !== 1) return { error: 'new takes exactly one name' };
    parsed.name = positional[0];
  } else if (positional.length > 0) {
    return { error: `unexpected argument "${positional[0]}"` };
  }
  return parsed;
}

/** `yyyymmddhhmmss` of a moment, in UTC. */
const versionOf = (date: Date): string => date.toISOString().replace(/[-:T]/g, '').slice(0, 14);

const NAME = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 60;

/** The text of a new migration: the phase rules, then the rollback note to fill in. */
const template = (name: string): string => `-- ${name}
--
-- Expand phase: additive changes only. DROP TABLE, DROP COLUMN and TRUNCATE go after a
-- "-- contract" line, in a later release than the code that stopped using them.
-- Conventions: packages/db/CONVENTIONS.md



-- Say how to undo this by hand, or why nothing is needed; the file must end with it.
-- rollback note:
`;

async function newMigration(deps: CliDeps, name: string, dir: string): Promise<number> {
  if (!NAME.test(name) || name.length > MAX_NAME_LENGTH) {
    deps.err(
      `centcom-db: the name must be snake_case (a-z, 0-9, _), at most ${MAX_NAME_LENGTH} characters\n`,
    );
    return EXIT.usage;
  }
  const fileName = `${versionOf(deps.now())}_${name}.sql`;
  if (parseMigrationFileName(fileName) === undefined) {
    deps.err(`centcom-db: cannot name a migration ${fileName}\n`);
    return EXIT.failed;
  }
  const path = join(dir, fileName);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path, template(name), { flag: 'wx' });
  } catch (err) {
    const exists = (err as { code?: unknown }).code === 'EEXIST';
    deps.err(`centcom-db: ${exists ? `${fileName} already exists` : `cannot write ${fileName}`}\n`);
    return EXIT.failed;
  }
  deps.out(`Created ${path}\nWrite the migration, then fill in its rollback note.\n`);
  return EXIT.ok;
}

async function runMigrate(
  deps: CliDeps,
  db: Kysely<Database>,
  dir: string,
  target?: string,
): Promise<number> {
  const { applied } = await migrate(db, dir, target === undefined ? {} : { target });
  deps.out(
    applied.length === 0
      ? 'Nothing to apply: the database is up to date.\n'
      : `Applied ${applied.length} migration${applied.length === 1 ? '' : 's'}:\n${applied.map((v) => `  ${v}\n`).join('')}`,
  );
  return EXIT.ok;
}

async function runStatus(deps: CliDeps, db: Kysely<Database>, dir: string): Promise<number> {
  const status = await migrationStatus(db, dir);
  const changed = new Set(status.changed.map((f) => f.version));
  const outOfOrder = new Set(status.outOfOrder.map((f) => f.version));
  const lines: string[] = [];
  for (const row of status.applied) {
    const state = changed.has(row.version)
      ? 'CHANGED'
      : status.missing.includes(row)
        ? 'no file'
        : 'applied';
    lines.push(`${state.padEnd(9)}${row.version}_${row.name}  ${row.appliedAt.toISOString()}`);
  }
  for (const file of status.pending) {
    lines.push(
      `${(outOfOrder.has(file.version) ? 'OUT OF ORDER' : 'pending').padEnd(9)}${file.version}_${file.name}`,
    );
  }
  lines.push(`${status.applied.length} applied, ${status.pending.length} pending`);
  deps.out(`${lines.join('\n')}\n`);
  if (changed.size > 0 || outOfOrder.size > 0) {
    deps.err(
      'centcom-db: migrate will refuse to run until the CHANGED or OUT OF ORDER files are fixed\n',
    );
    return EXIT.failed;
  }
  return EXIT.ok;
}

/** One line for an error that stopped a command, without values from the environment. */
function describeFailure(err: unknown): string {
  if (err instanceof ConfigError || err instanceof MigrationError) return err.message;
  if (err instanceof AppError && err.code === 'service_unavailable') {
    const cause = err.cause instanceof Error ? `: ${err.cause.message}` : '';
    return `the database is unreachable${cause}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Runs one CLI command and returns its exit code. Never throws. */
export async function runCli(
  argv: readonly string[],
  overrides: Partial<CliDeps> = {},
): Promise<number> {
  const deps: CliDeps = { ...defaultDeps(), ...overrides };
  const parsed = parseArgs(argv);
  if ('error' in parsed) {
    deps.err(`centcom-db: ${parsed.error}\n\n${USAGE}`);
    return EXIT.usage;
  }
  const dir = parsed.dir ?? deps.dir;
  if (parsed.command === 'help') {
    deps.out(USAGE);
    return EXIT.ok;
  }
  if (parsed.command === 'new') return newMigration(deps, parsed.name ?? '', dir);
  let db: Kysely<Database> | undefined;
  try {
    db = deps.openDb(deps.databaseUrl());
    return parsed.command === 'migrate'
      ? await runMigrate(deps, db, dir, parsed.target)
      : await runStatus(deps, db, dir);
  } catch (err) {
    deps.err(`centcom-db: ${describeFailure(err)}\n`);
    return EXIT.failed;
  } finally {
    if (db !== undefined) await closeDb(db).catch(() => undefined);
  }
}

/** True when this file is the process's entry script (node dist/cli.js, or the centcom-db bin). */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = await runCli(process.argv.slice(2));
}
