/**
 * The `centcom-db` CLI (B007): usage and argument errors (exit 2), `new` (file, name rules, no
 * overwrite), `migrate` and `status` output and exit codes, configuration errors and the
 * production TLS rule, and an unreachable database, never printing the connection string. Against
 * the fake always, and end to end against a real Postgres 16 when DATABASE_URL is set.
 */
import { appendFile, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigError } from '@centcom/core';
import { afterEach, describe, expect, it } from 'vitest';
import { cliConfig, EXIT, runCli, USAGE, type CliDeps } from '../../src/cli.js';
import { closeDb, createDb, type Database } from '../../src/index.js';
import { FakePostgres } from './fake-postgres.js';
import {
  ADMIN_URL,
  closedPort,
  FIXTURES,
  SAMPLE_VERSIONS,
  scratchDir,
  tempDatabase,
} from './helpers.js';

const PASSWORD = ['pw', 'cli', 'secret'].join('-');

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** Runs the CLI with captured output and the given dependencies. */
async function cli(
  argv: string[],
  deps: Partial<CliDeps> = {},
): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await runCli(argv, {
    out: (t) => {
      out += t;
    },
    err: (t) => {
      err += t;
    },
    ...deps,
  });
  return { code, out, err };
}

/** Dependencies that point the CLI at a fake database. */
const onFake = (server: FakePostgres, dir?: string): Partial<CliDeps> => ({
  databaseUrl: () => 'postgres://fake/db',
  openDb: () => server.connect<Database>(),
  ...(dir === undefined ? {} : { dir }),
});

describe('usage', () => {
  it('prints the usage for help, -h, --help or no command, exit 0', async () => {
    for (const argv of [[], ['help'], ['-h'], ['--help']]) {
      expect(await cli(argv)).toEqual({ code: EXIT.ok, out: USAGE, err: '' });
    }
  });

  it.each([
    [['frob'], 'unknown command "frob"'],
    [['migrate', '--force'], 'unknown option "--force"'],
    [['migrate', '--dir'], '--dir needs a value'],
    [['migrate', '--target='], '--target needs a value'],
    [['status', '--target', '20260101000000'], '--target only applies to migrate'],
    [['status', 'extra'], 'unexpected argument "extra"'],
    [['new'], 'new takes exactly one name'],
    [['new', 'a', 'b'], 'new takes exactly one name'],
  ])('%j is a usage error, exit 2', async (argv, message) => {
    const result = await cli(argv);
    expect(result.code).toBe(EXIT.usage);
    expect(result.err).toBe(`centcom-db: ${message}\n\n${USAGE}`);
  });
});

describe('new', () => {
  const now = (): Date => new Date('2026-10-07T04:05:06.789Z');

  it('creates <utc timestamp>_<name>.sql, creating the directory if needed', async () => {
    const { dir: parent, remove } = await scratchDir();
    cleanups.push(remove);
    const dir = join(parent, 'migrations');
    const result = await cli(['new', 'add_widgets', `--dir=${dir}`], { now });
    expect(result.code).toBe(EXIT.ok);
    expect(await readdir(dir)).toEqual(['20261007040506_add_widgets.sql']);
    expect(result.out).toContain('20261007040506_add_widgets.sql');
    const text = await readFile(join(dir, '20261007040506_add_widgets.sql'), 'utf8');
    expect(text.startsWith('-- add_widgets\n')).toBe(true);
    expect(text.trimEnd().endsWith('-- rollback note:')).toBe(true);
  });

  it('refuses a name that is not snake_case, or too long (exit 2)', async () => {
    const { dir, remove } = await scratchDir();
    cleanups.push(remove);
    for (const name of [
      'AddWidgets',
      'add-widgets',
      'add__widgets',
      '_add',
      'a'.repeat(61),
      'émoji',
    ]) {
      const result = await cli(['new', name, '--dir', dir], { now });
      expect(result.code, name).toBe(EXIT.usage);
      expect(result.err).toContain('snake_case');
    }
    expect(await readdir(dir)).toEqual([]);
  });

  it('never overwrites a file (exit 1)', async () => {
    const { dir, remove } = await scratchDir();
    cleanups.push(remove);
    expect((await cli(['new', 'add_widgets', '--dir', dir], { now })).code).toBe(EXIT.ok);
    await appendFile(
      join(dir, '20261007040506_add_widgets.sql'),
      'create table widgets (id int);\n',
    );
    const again = await cli(['new', 'add_widgets', '--dir', dir], { now });
    expect(again).toMatchObject({
      code: EXIT.failed,
      err: 'centcom-db: 20261007040506_add_widgets.sql already exists\n',
    });
    expect(await readFile(join(dir, '20261007040506_add_widgets.sql'), 'utf8')).toContain(
      'create table widgets',
    );
  });
});

describe('migrate and status (fake database)', () => {
  it('migrate applies and lists the versions, then says there is nothing to apply', async () => {
    const server = new FakePostgres();
    const first = await cli(['migrate'], onFake(server, FIXTURES.sample));
    expect(first).toEqual({
      code: EXIT.ok,
      out: `Applied 3 migrations:\n${SAMPLE_VERSIONS.map((v) => `  ${v}\n`).join('')}`,
      err: '',
    });
    expect(await cli(['migrate', '--dir', FIXTURES.sample], onFake(server))).toMatchObject({
      code: EXIT.ok,
      out: 'Nothing to apply: the database is up to date.\n',
    });
  });

  it('migrate --target stops at that version', async () => {
    const server = new FakePostgres();
    const result = await cli(
      ['migrate', '--target', SAMPLE_VERSIONS[0]],
      onFake(server, FIXTURES.sample),
    );
    expect(result.out).toBe(`Applied 1 migration:\n  ${SAMPLE_VERSIONS[0]}\n`);
  });

  it('migrate exits 1 with the failing file named', async () => {
    const result = await cli(['migrate'], onFake(new FakePostgres(), FIXTURES.failing));
    expect(result.code).toBe(EXIT.failed);
    expect(result.err).toMatch(
      /^centcom-db: 20260101000100_half_done\.sql failed and was rolled back: division by zero \(SQLSTATE 22012\)\n$/,
    );
  });

  it('status lists applied and pending files, exit 0', async () => {
    const server = new FakePostgres();
    await cli(['migrate', '--target', SAMPLE_VERSIONS[0]], onFake(server, FIXTURES.sample));
    const result = await cli(['status'], onFake(server, FIXTURES.sample));
    expect(result.code).toBe(EXIT.ok);
    const lines = result.out.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^applied {2}20260101000000_create_widgets {2}\d{4}-\d{2}-\d{2}T/);
    expect(lines.slice(1)).toEqual([
      'pending  20260101000100_add_widget_color',
      'pending  20260101000200_create_gadgets',
      '1 applied, 2 pending',
    ]);
  });

  it('status exits 1 when a file changed after it was applied, or is out of order', async () => {
    const server = new FakePostgres();
    const { dir, remove } = await scratchDir(FIXTURES.sample);
    cleanups.push(remove);
    await cli(['migrate', '--target', SAMPLE_VERSIONS[1]], onFake(server, dir));
    await appendFile(join(dir, '20260101000000_create_widgets.sql'), '-- edited\n');
    const result = await cli(['status'], onFake(server, dir));
    expect(result.code).toBe(EXIT.failed);
    expect(result.out).toMatch(/^CHANGED {2}20260101000000_create_widgets/m);
    expect(result.err).toContain('migrate will refuse to run');
  });
});

describe('configuration and connection errors', () => {
  it('exits 1 naming the missing keys, never a value', async () => {
    const result = await cli(['status'], {
      databaseUrl: () => {
        throw new ConfigError([{ key: 'DATABASE_URL', problem: 'is required' }]);
      },
    });
    expect(result).toEqual({
      code: EXIT.failed,
      out: '',
      err: 'centcom-db: Invalid configuration:\n  DATABASE_URL: is required\n',
    });
  });

  it('reads DATABASE_URL with the production TLS rule baseConfig applies', () => {
    const url = `postgres://centcom:${PASSWORD}@db.internal:5432/centcom`;
    expect(cliConfig({ NODE_ENV: 'development', DATABASE_URL: url }).databaseUrl.reveal()).toBe(
      url,
    );
    expect(
      cliConfig({
        NODE_ENV: 'production',
        DATABASE_URL: `${url}?sslmode=verify-full`,
      }).databaseUrl.reveal(),
    ).toContain('sslmode=verify-full');
    expect(() => cliConfig({ NODE_ENV: 'production', DATABASE_URL: url })).toThrow(/sslmode/);
    expect(() =>
      cliConfig({ NODE_ENV: 'production', DATABASE_URL: `${url}?sslmode=require&sslmode=disable` }),
    ).toThrow(ConfigError);
    expect(
      cliConfig({ NODE_ENV: 'production', DATABASE_URL: url, ALLOW_INSECURE_BACKENDS: '1' }),
    ).toBeDefined();
    let err: unknown;
    try {
      cliConfig({ NODE_ENV: 'production', DATABASE_URL: url });
    } catch (e) {
      err = e;
    }
    expect(String(err)).not.toContain(PASSWORD);
    expect(() => cliConfig({ NODE_ENV: 'development' })).toThrow(/DATABASE_URL/);
    expect(() =>
      cliConfig({ NODE_ENV: 'development', DATABASE_URL: 'mysql://localhost/db' }),
    ).toThrow(ConfigError);
  });

  it('exits 1 when the database is unreachable, without printing the URL', async () => {
    const url = `postgres://centcom:${PASSWORD}@127.0.0.1:${await closedPort()}/centcom`;
    const result = await cli(['migrate', '--dir', FIXTURES.sample], { databaseUrl: () => url });
    expect(result.code).toBe(EXIT.failed);
    expect(result.err).toMatch(/^centcom-db: the database is unreachable: connect ECONNREFUSED/);
    expect(result.err + result.out).not.toContain(PASSWORD);
  });
});

describe.runIf(ADMIN_URL !== undefined)('end to end against Postgres 16', () => {
  it('migrate, then status, through the default connection settings', async () => {
    const { url, drop } = await tempDatabase();
    cleanups.push(drop);
    const deps = { databaseUrl: () => url, dir: FIXTURES.sample };
    const migrated = await cli(['migrate'], deps);
    expect(migrated).toMatchObject({
      code: EXIT.ok,
      out: expect.stringContaining('Applied 3 migrations'),
    });
    const status = await cli(['status'], deps);
    expect(status.code).toBe(EXIT.ok);
    expect(status.out).toContain('3 applied, 0 pending');
    const db = createDb<Database>({ url });
    cleanups.push(() => closeDb(db));
    expect(
      (await db.selectFrom('schema_migrations').select('version').orderBy('version').execute()).map(
        (r) => r.version,
      ),
    ).toEqual([...SAMPLE_VERSIONS]);
  });
});
