/**
 * healthCheck (B007 acceptance 6): reachable and at, behind or ahead of the expected migration
 * version, a fresh database, a build without migrations or with unreadable ones, and an
 * unreachable or silent database (never throws, never waits past its timeout). Against the fake
 * and local sockets always; against a real Postgres 16 when DATABASE_URL is set.
 */
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Kysely } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeDb,
  createDb,
  DEFAULT_HEALTH_TIMEOUT_MS,
  healthCheck,
  migrate,
  type Database,
} from '../../src/index.js';
import { FakePostgres } from './fake-postgres.js';
import {
  ADMIN_URL,
  closedPort,
  FIXTURES,
  SAMPLE_VERSIONS,
  scratchDir,
  silentServer,
  tempDatabase,
} from './helpers.js';
import { wireServer } from './wire-server.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function copyOf(fixture?: string): Promise<string> {
  const { dir, remove } = await scratchDir(fixture);
  cleanups.push(remove);
  return dir;
}

function open(url: string, connectTimeoutMs?: number): Kysely<Database> {
  const db = createDb<Database>(
    connectTimeoutMs === undefined ? { url } : { url, connectTimeoutMs },
  );
  cleanups.push(() => closeDb(db));
  return db;
}

/** The three version checks, run against whichever database `connect` opens. */
function versionCases(connect: () => Promise<Kysely<Database>>): void {
  it('is not at the expected version on a fresh database', async () => {
    const db = await connect();
    expect(await healthCheck(db, { dir: FIXTURES.sample })).toEqual({
      ok: true,
      migrationsAtExpected: false,
      expectedVersion: SAMPLE_VERSIONS[2],
      currentVersion: null,
    });
  });

  it('reports migrationsAtExpected false when the database is one migration behind (acceptance 6)', async () => {
    const db = await connect();
    await migrate(db, FIXTURES.sample, { target: SAMPLE_VERSIONS[1] });
    expect(await healthCheck(db, { dir: FIXTURES.sample })).toEqual({
      ok: true,
      migrationsAtExpected: false,
      expectedVersion: SAMPLE_VERSIONS[2],
      currentVersion: SAMPLE_VERSIONS[1],
    });
  });

  it('is at the expected version once every migration is applied', async () => {
    const db = await connect();
    await migrate(db, FIXTURES.sample);
    expect(await healthCheck(db, { dir: FIXTURES.sample })).toMatchObject({
      ok: true,
      migrationsAtExpected: true,
      currentVersion: SAMPLE_VERSIONS[2],
    });
  });

  it('counts a database ahead of the build as ready (the previous release during a deploy)', async () => {
    const db = await connect();
    await migrate(db, FIXTURES.sample);
    const older = await copyOf(FIXTURES.sample);
    await rm(join(older, '20260101000200_create_gadgets.sql'));
    expect(await healthCheck(db, { dir: older })).toEqual({
      ok: true,
      migrationsAtExpected: true,
      expectedVersion: SAMPLE_VERSIONS[1],
      currentVersion: SAMPLE_VERSIONS[2],
    });
  });
}

describe('healthCheck against the fake', () => {
  versionCases(async () => new FakePostgres().connect<Database>());

  it('is at the expected version when the build has no migrations', async () => {
    const dir = await copyOf();
    await writeFile(join(dir, 'README.md'), 'no migrations yet');
    expect(await healthCheck(new FakePostgres().connect(), { dir })).toEqual({
      ok: true,
      migrationsAtExpected: true,
      expectedVersion: null,
      currentVersion: null,
    });
  });

  it('is never at the expected version when the build cannot read its migrations', async () => {
    const missing = await copyOf();
    await rm(missing, { recursive: true });
    const badlyNamed = await copyOf();
    await writeFile(join(badlyNamed, 'v2_users.sql'), 'select 1;');
    for (const dir of [missing, badlyNamed]) {
      expect(await healthCheck(new FakePostgres().connect(), { dir })).toEqual({
        ok: true,
        migrationsAtExpected: false,
        expectedVersion: null,
        currentVersion: null,
      });
    }
  });

  it('reports ok false, without throwing, when queries fail', async () => {
    const server = new FakePostgres();
    server.down = true;
    expect(await healthCheck(server.connect(), { dir: FIXTURES.sample })).toEqual({
      ok: false,
      migrationsAtExpected: false,
      expectedVersion: SAMPLE_VERSIONS[2],
      currentVersion: null,
    });
  });
});

describe('healthCheck over the network', () => {
  it('reports an unreachable database as ok false (failure mode)', async () => {
    const db = open(`postgres://centcom:unused@127.0.0.1:${await closedPort()}/centcom`);
    expect(await healthCheck(db, { dir: FIXTURES.sample })).toMatchObject({
      ok: false,
      migrationsAtExpected: false,
    });
  });

  it('gives up on a database that does not answer after its timeout', async () => {
    const silent = await silentServer();
    cleanups.push(silent.close);
    const db = open(silent.url, 1_000);
    const started = performance.now();
    const report = await healthCheck(db, { dir: FIXTURES.sample, timeoutMs: 200 });
    const elapsed = performance.now() - started;
    expect(report.ok).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(800);
    expect(DEFAULT_HEALTH_TIMEOUT_MS).toBe(2_000);
  });

  it('reports ok true for a server that answers, through the real driver', async () => {
    const server = await wireServer();
    cleanups.push(server.close);
    const dir = await copyOf();
    expect(await healthCheck(open(server.url), { dir })).toMatchObject({
      ok: true,
      migrationsAtExpected: true,
    });
  });
});

describe.runIf(ADMIN_URL !== undefined)('healthCheck against Postgres 16', () => {
  versionCases(async () => {
    const { url, drop } = await tempDatabase();
    cleanups.push(drop);
    return open(url);
  });
});
