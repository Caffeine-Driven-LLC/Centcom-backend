/**
 * The migration runner (B007 acceptance 1-4, the lock failure mode): ordering and idempotence,
 * checksum protection, the advisory lock, atomic failure, plus targets, out-of-order files and
 * status. Each case runs against the in-memory fake (always) and against a real Postgres 16 in a
 * throwaway database (when DATABASE_URL is set, as in CI's integration job), which is the reference.
 */
import { appendFile, cp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { sql, type Kysely } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeDb,
  createDb,
  migrate,
  migrationChecksum,
  MIGRATION_LOCK_KEY,
  MIGRATION_LOCK_NAME,
  migrationStatus,
  readMigrations,
  type Database,
} from '../../src/index.js';
import { FakePostgres } from './fake-postgres.js';
import {
  ADMIN_URL,
  FIXTURES,
  onDatabase,
  SAMPLE_VERSIONS,
  scratchDir,
  tempDatabase,
} from './helpers.js';

/** One database for one test, with as many independent connections ("processes") as it needs. */
interface Backend {
  connect(): Kysely<Database>;
  /** Table names in the public schema. */
  tables(): Promise<string[]>;
  /** Rows of schema_migrations. */
  rows(): Promise<{ version: string; name: string; checksum: string }[]>;
  /** Holds the migration lock from another session until the returned function is called. */
  holdLock(): Promise<() => Promise<void>>;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function fakeBackend(): Promise<Backend> {
  const server = new FakePostgres();
  return {
    connect: () => server.connect<Database>(),
    tables: async () => {
      // The fake tracks only the bookkeeping table; created tables show up as committed statements.
      const created = server.committed.flatMap((s) =>
        [...s.matchAll(/create table (\w+)/gi)].map((m) => m[1] ?? ''),
      );
      return [...(server.hasTable ? ['schema_migrations'] : []), ...created].sort();
    },
    rows: async () =>
      [...server.rows].map(({ version, name, checksum }) => ({ version, name, checksum })),
    holdLock: async () => {
      const other = {};
      server.lockHolder = other;
      return async () => {
        if (server.lockHolder === other) server.lockHolder = undefined;
      };
    },
  };
}

async function postgresBackend(): Promise<Backend> {
  const { url, drop } = await tempDatabase();
  const opened: Kysely<Database>[] = [];
  cleanups.push(async () => {
    await Promise.all(opened.map((db) => closeDb(db)));
    await drop();
  });
  return {
    connect: () => {
      const db = createDb<Database>({ url });
      opened.push(db);
      return db;
    },
    tables: () =>
      onDatabase(url, async (c) =>
        (
          await c.query<{ name: string }>(
            "select tablename as name from pg_tables where schemaname = 'public' order by 1",
          )
        ).rows.map((r) => r.name),
      ),
    rows: () =>
      onDatabase(
        url,
        async (c) =>
          (await c.query('select version, name, checksum from schema_migrations order by version'))
            .rows,
      ),
    holdLock: async () => {
      const db = createDb<Database>({ url, poolMax: 1 });
      opened.push(db);
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked!: () => void;
      const isLocked = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const holding = db.connection().execute(async (conn) => {
        await sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY}::bigint)`.execute(conn);
        locked();
        await released;
        await sql`select pg_advisory_unlock(${MIGRATION_LOCK_KEY}::bigint)`.execute(conn);
      });
      await isLocked;
      return async () => {
        release();
        await holding;
      };
    },
  };
}

/** A scratch copy of a fixture directory, removed after the test. */
async function copyOf(fixture: string): Promise<string> {
  const { dir, remove } = await scratchDir(fixture);
  cleanups.push(remove);
  return dir;
}

const backends: [string, () => Promise<Backend>, boolean][] = [
  ['in-memory fake', fakeBackend, true],
  ['Postgres 16', postgresBackend, ADMIN_URL !== undefined],
];

for (const [label, open, enabled] of backends) {
  describe.runIf(enabled)(`migrate against ${label}`, () => {
    it('applies the 3 sample migrations in version order, then nothing on a second run (acceptance 1)', async () => {
      const backend = await open();
      const db = backend.connect();
      expect(await migrate(db, FIXTURES.sample)).toEqual({ applied: [...SAMPLE_VERSIONS] });
      const files = await readMigrations(FIXTURES.sample);
      expect(await backend.rows()).toEqual(
        files.map((f) => ({ version: f.version, name: f.name, checksum: f.checksum })),
      );
      expect(await backend.tables()).toEqual(['gadgets', 'schema_migrations', 'widgets']);

      expect(await migrate(db, FIXTURES.sample)).toEqual({ applied: [] });
      expect(await migrate(backend.connect(), FIXTURES.sample)).toEqual({ applied: [] });
      expect(await backend.rows()).toHaveLength(3);
    });

    it('refuses to run, and applies nothing, when an applied file was edited (acceptance 2)', async () => {
      const backend = await open();
      const db = backend.connect();
      const dir = await copyOf(FIXTURES.sample);
      await rm(join(dir, '20260101000200_create_gadgets.sql'));
      expect((await migrate(db, dir)).applied).toEqual(SAMPLE_VERSIONS.slice(0, 2));

      // A pending file arrives with the edit: it must not be applied either.
      await cp(
        join(FIXTURES.sample, '20260101000200_create_gadgets.sql'),
        join(dir, '20260101000200_create_gadgets.sql'),
      );
      await appendFile(
        join(dir, '20260101000100_add_widget_color.sql'),
        '-- an innocent-looking edit\n',
      );
      const err = await migrate(db, dir).catch((e: unknown) => e);
      expect(err).toMatchObject({
        name: 'MigrationError',
        code: 'checksum_mismatch',
        message: expect.stringContaining('20260101000100_add_widget_color.sql'),
      });
      expect((await backend.rows()).map((r) => r.version)).toEqual(SAMPLE_VERSIONS.slice(0, 2));
      expect(await backend.tables()).not.toContain('gadgets');
    });

    it('lets one of two concurrent runs apply; the other waits for the lock, then applies nothing (acceptance 3)', async () => {
      const backend = await open();
      const [first, second] = [backend.connect(), backend.connect()];
      const results = await Promise.all([
        migrate(first, FIXTURES.slow, { lockPollMs: 20 }),
        migrate(second, FIXTURES.slow, { lockPollMs: 20 }),
      ]);
      const applied = results.map((r) => r.applied).sort((a, b) => b.length - a.length);
      expect(applied).toEqual([['20260101000000', '20260101000100'], []]);
      expect(await backend.rows()).toHaveLength(2);
    });

    it('leaves no partial changes and no row when a migration fails midway (acceptance 4)', async () => {
      const backend = await open();
      const db = backend.connect();
      const err = await migrate(db, FIXTURES.failing).catch((e: unknown) => e);
      expect(err).toMatchObject({
        name: 'MigrationError',
        code: 'migration_failed',
        message: expect.stringContaining('20260101000100_half_done.sql failed and was rolled back'),
      });
      // The first file stays applied; the failing one and everything after it left nothing.
      expect((await backend.rows()).map((r) => r.version)).toEqual(['20260101000000']);
      const tables = await backend.tables();
      expect(tables).toContain('widgets');
      expect(tables).not.toContain('half_done');
      expect(tables).not.toContain('gadgets');
    });

    it('gives up with a message naming the lock when another session holds it (failure mode)', async () => {
      const backend = await open();
      const release = await backend.holdLock();
      try {
        const started = performance.now();
        const err = await migrate(backend.connect(), FIXTURES.sample, {
          lockTimeoutMs: 300,
          lockPollMs: 50,
        }).catch((e: unknown) => e);
        expect(err).toMatchObject({
          code: 'lock_timeout',
          message: expect.stringContaining(MIGRATION_LOCK_NAME),
        });
        expect(performance.now() - started).toBeGreaterThanOrEqual(250);
        expect(await backend.rows()).toEqual([]);
      } finally {
        await release();
      }
      expect((await migrate(backend.connect(), FIXTURES.sample)).applied).toHaveLength(3);
    });

    it('stops at a target version, and refuses an unknown one', async () => {
      const backend = await open();
      const db = backend.connect();
      expect(await migrate(db, FIXTURES.sample, { target: SAMPLE_VERSIONS[1] })).toEqual({
        applied: SAMPLE_VERSIONS.slice(0, 2),
      });
      await expect(
        migrate(db, FIXTURES.sample, { target: '20991231235959' }),
      ).rejects.toMatchObject({
        code: 'unknown_target',
      });
      expect(await migrate(db, FIXTURES.sample)).toEqual({ applied: [SAMPLE_VERSIONS[2]] });
    });

    it('refuses a pending file older than the newest applied one', async () => {
      const backend = await open();
      const db = backend.connect();
      const dir = await copyOf(FIXTURES.sample);
      const middle = '20260101000100_add_widget_color.sql';
      await rm(join(dir, middle));
      expect((await migrate(db, dir)).applied).toEqual([SAMPLE_VERSIONS[0], SAMPLE_VERSIONS[2]]);
      await cp(join(FIXTURES.sample, middle), join(dir, middle));
      await expect(migrate(db, dir)).rejects.toMatchObject({
        code: 'out_of_order',
        message: expect.stringContaining(middle),
      });
      expect(await backend.rows()).toHaveLength(2);
    });

    it('reports status: pending, applied, changed, out of order and missing files', async () => {
      const backend = await open();
      const db = backend.connect();
      const dir = await copyOf(FIXTURES.sample);
      const fresh = await migrationStatus(db, dir);
      expect(fresh.applied).toEqual([]);
      expect(fresh.pending.map((f) => f.version)).toEqual([...SAMPLE_VERSIONS]);

      await migrate(db, dir, { target: SAMPLE_VERSIONS[1] });
      await appendFile(join(dir, '20260101000000_create_widgets.sql'), '-- edited\n');
      await rm(join(dir, '20260101000100_add_widget_color.sql'));
      const status = await migrationStatus(db, dir);
      expect(status.applied.map((r) => r.version)).toEqual(SAMPLE_VERSIONS.slice(0, 2));
      expect(status.applied[0]?.appliedAt).toBeInstanceOf(Date);
      expect(status.changed.map((f) => f.version)).toEqual([SAMPLE_VERSIONS[0]]);
      expect(status.missing.map((r) => r.version)).toEqual([SAMPLE_VERSIONS[1]]);
      expect(status.pending.map((f) => f.version)).toEqual([SAMPLE_VERSIONS[2]]);
      expect(status.outOfOrder).toEqual([]);
    });

    it('records the checksum of the normalised text', async () => {
      const backend = await open();
      await migrate(backend.connect(), FIXTURES.sample, { target: SAMPLE_VERSIONS[0] });
      const [file] = await readMigrations(FIXTURES.sample);
      expect((await backend.rows())[0]?.checksum).toBe(migrationChecksum(file?.sql ?? ''));
    });
  });
}

describe('migrate with the fake only', () => {
  it('releases the lock after a failure, so the next run can go ahead', async () => {
    const server = new FakePostgres();
    await expect(migrate(server.connect(), FIXTURES.failing)).rejects.toMatchObject({
      code: 'migration_failed',
    });
    expect(server.lockHolder).toBeUndefined();
    expect(server.rollbacks).toBe(1);
  });

  it('takes the lock before anything else and releases it last', async () => {
    const server = new FakePostgres();
    await migrate(server.connect(), FIXTURES.sample);
    const kinds = server.statements.map((s) => s.split(' ').slice(0, 3).join(' '));
    expect(kinds[0]).toBe('select pg_try_advisory_lock($1::bigint) as');
    expect(kinds.at(-1)).toBe('select pg_advisory_unlock($1::bigint)');
  });

  it('passes a lost connection on, still releasing what it can', async () => {
    const server = new FakePostgres();
    const db = server.connect();
    server.failOn('create table if not exists schema_migrations', '08006', 1, 'connection failure');
    await expect(migrate(db, FIXTURES.sample)).rejects.toMatchObject({ code: '08006' });
    expect(server.lockHolder).toBeUndefined();
  });
});
