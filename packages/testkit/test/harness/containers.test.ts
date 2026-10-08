/**
 * The test stack (B010 acceptance 1, 2, 3 and 7, guardrails and failure modes). Without any
 * server, through an injected runtime: both URLs set means no container is asked for; missing
 * ones are started once per process; no runtime fails fast with what to set. With a real stack
 * (CI's services, or containers when Docker answers): migrated in under 20 s, reused in under
 * 2 s, reset empties the tables and the Redis namespace, parallel stacks are isolated, stop drops
 * the database, and stale throwaway databases are reaped.
 */
import { newId } from '@centcom/contracts';
import { Redis } from 'ioredis';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import {
  assertTestDatabaseName,
  createFactories,
  reapStaleTestDatabases,
  resolveTestServers,
  startTestStack,
  testcontainersRuntime,
  TestStackError,
  type ContainerRuntime,
  type TestStack,
} from '../../src/index.js';
import { CONTAINER_TEST_TIMEOUT_MS, CONTAINERS, RUNTIME, STACK } from './helpers.js';

/** A runtime that records what it was asked to do and starts nothing real. */
function spyRuntime(opts: { available?: boolean } = {}): ContainerRuntime & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    check: async () => {
      calls.push('check');
      if (opts.available === false) throw new TestStackError('no runtime here');
    },
    pull: async () => {
      calls.push('pull');
    },
    startPostgres: async () => {
      calls.push('postgres');
      return { url: 'postgres://test:test@127.0.0.1:55432/test', stop: async () => undefined };
    },
    startRedis: async () => {
      calls.push('redis');
      return { url: 'redis://127.0.0.1:56379', stop: async () => undefined };
    },
  };
}

describe('choosing the servers', () => {
  const both = {
    DATABASE_URL: 'postgres://ci:ci@localhost:5432/ci',
    REDIS_URL: 'redis://localhost:6379/0',
  };

  it('starts no container when DATABASE_URL and REDIS_URL are both set (acceptance 7)', async () => {
    const runtime = spyRuntime();
    expect(await resolveTestServers(both, runtime)).toEqual({
      databaseUrl: both.DATABASE_URL,
      redisUrl: both.REDIS_URL,
      source: 'env',
    });
    expect(runtime.calls).toEqual([]);
  });

  it('starts only what is missing, once per process for concurrent callers', async () => {
    const runtime = spyRuntime();
    const [a, b] = await Promise.all([
      resolveTestServers({ DATABASE_URL: both.DATABASE_URL }, runtime),
      resolveTestServers({ DATABASE_URL: both.DATABASE_URL }, runtime),
    ]);
    expect(a).toEqual({
      databaseUrl: both.DATABASE_URL,
      redisUrl: 'redis://127.0.0.1:56379',
      source: 'mixed',
    });
    expect(b).toEqual(a);
    expect(runtime.calls).toEqual(['check', 'redis']);

    const none = spyRuntime();
    expect(await resolveTestServers({}, none)).toMatchObject({ source: 'containers' });
    expect([...none.calls].sort()).toEqual(['check', 'postgres', 'redis']);
  });

  it('fails fast, saying what to set, when there is no runtime and no URLs (failure mode)', async () => {
    const runtime = spyRuntime({ available: false });
    const started = performance.now();
    const err = await startTestStack({ env: {}, runtime }).catch((e: unknown) => e);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(err).toBeInstanceOf(TestStackError);
    expect(runtime.calls).toEqual(['check']);
    // A failed start is not remembered: the next call asks again.
    await expect(resolveTestServers({}, runtime)).rejects.toThrow(TestStackError);
    expect(runtime.calls).toEqual(['check', 'check']);
  });

  it("explains itself with the real runtime's message", async () => {
    const err = await testcontainersRuntime.check().catch((e: unknown) => e);
    if (RUNTIME) expect(err).toBeUndefined();
    else expect(String(err)).toMatch(/Start Docker, or set DATABASE_URL .* and REDIS_URL/);
  });
});

describe('the database name guard (guardrail)', () => {
  it('accepts only names the kit makes', () => {
    expect(() => assertTestDatabaseName('test_1791374400_abcdef12')).not.toThrow();
    for (const name of [
      'centcom',
      'centcom_test',
      'test',
      'test_prod',
      'test_1_abcdef12',
      'test_1791374400_ABCDEF12',
      'TEST_1791374400_abcdef12',
    ]) {
      expect(() => assertTestDatabaseName(name), name).toThrow(TestStackError);
    }
  });
});

describe.runIf(STACK)('a real stack', () => {
  const stacks: TestStack[] = [];
  afterAll(async () => {
    await Promise.all(stacks.map((s) => s.stop()));
  }, CONTAINER_TEST_TIMEOUT_MS);

  const tableCounts = async (stack: TestStack): Promise<Record<string, number>> => {
    const { rows } = await sql<{ name: string }>`
      select tablename as name from pg_tables where schemaname = 'public' order by 1
    `.execute(stack.db);
    const counts: Record<string, number> = {};
    for (const { name } of rows) {
      const result = await sql<{ n: string }>`select count(*) as n from ${sql.table(name)}`.execute(
        stack.db,
      );
      counts[name] = Number(result.rows[0]?.n);
    }
    return counts;
  };

  it(
    'starts migrated in under 20 s, cold (acceptance 1)',
    async () => {
      // Pulling images is not part of starting: do it first when containers are used.
      if (CONTAINERS) await testcontainersRuntime.pull();
      const started = performance.now();
      const stack = await startTestStack();
      stacks.push(stack);
      expect(performance.now() - started).toBeLessThan(20_000);
      expect(stack.databaseName).toMatch(/^test_\d{10}_[0-9a-f]{8}$/);
      const versions = await sql<{
        version: string;
      }>`select version from schema_migrations`.execute(stack.db);
      expect(versions.rows.map((r) => r.version)).toContain('20260101000000');
      const counts = await tableCounts(stack);
      expect(Object.keys(counts)).toEqual(
        expect.arrayContaining([
          'users',
          'devices',
          'workspaces',
          'memberships',
          'sessions',
          'session_members',
        ]),
      );
    },
    CONTAINER_TEST_TIMEOUT_MS,
  );

  it(
    'returns the same stack from reuse in under 2 s, and a new one after it was stopped',
    async () => {
      const first = await startTestStack({ reuse: true });
      const started = performance.now();
      const again = await startTestStack({ reuse: true });
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(again).toBe(first);
      await first.stop();
      const fresh = await startTestStack({ reuse: true });
      stacks.push(fresh);
      expect(fresh).not.toBe(first);
      expect(fresh.databaseName).not.toBe(first.databaseName);
    },
    CONTAINER_TEST_TIMEOUT_MS,
  );

  it(
    'reset() empties every application table and the Redis namespace, not schema_migrations (acceptance 2)',
    async () => {
      const stack = await startTestStack();
      stacks.push(stack);
      const make = createFactories(stack.db);
      const workspace = await make.workspaces.create();
      const session = await make.sessions.create({ workspace });
      await make.sessionMembers.create({ session });
      // audit_events is append-only (B036): its trigger refuses TRUNCATE, yet reset() empties it.
      await sql`
        insert into audit_events (id, workspace_id, actor_type, actor_id, action, outcome)
        values (${newId('aud')}, ${workspace.id}, 'system', 'testkit', 'workspace.create', 'success')
      `.execute(stack.db);
      const redis = new Redis(stack.redisUrl, { maxRetriesPerRequest: 1 });
      try {
        await redis.set(`${stack.redisKeyPrefix}left-over`, 'v', 'PX', 60_000);
        await redis.set('ct:other-namespace:kept', 'v', 'PX', 60_000);
        const migrations = (await tableCounts(stack))['schema_migrations'];
        await stack.reset();
        const counts = await tableCounts(stack);
        expect(counts['schema_migrations']).toBe(migrations);
        for (const [table, n] of Object.entries(counts))
          if (table !== 'schema_migrations') expect(n, table).toBe(0);
        expect(await redis.exists(`${stack.redisKeyPrefix}left-over`)).toBe(0);
        expect(await redis.exists('ct:other-namespace:kept')).toBe(1);
        // The trigger is back on afterwards.
        await expect(sql`truncate table audit_events`.execute(stack.db)).rejects.toMatchObject({
          code: '42501',
        });
      } finally {
        await redis.del('ct:other-namespace:kept');
        redis.disconnect();
      }
    },
    CONTAINER_TEST_TIMEOUT_MS,
  );

  it(
    'gives parallel stacks their own databases and namespaces (acceptance 3)',
    async () => {
      const [a, b] = await Promise.all([startTestStack(), startTestStack()]);
      stacks.push(a, b);
      expect(a.databaseName).not.toBe(b.databaseName);
      expect(a.redisKeyPrefix).not.toBe(b.redisKeyPrefix);
      await createFactories(a.db).users.create();
      expect((await tableCounts(a))['users']).toBe(1);
      expect((await tableCounts(b))['users']).toBe(0);
    },
    CONTAINER_TEST_TIMEOUT_MS,
  );

  it(
    'stop() drops the database, and is idempotent',
    async () => {
      const stack = await startTestStack();
      const servers = await resolveTestServers();
      await stack.stop();
      await stack.stop();
      const exists = await onServer(
        servers.databaseUrl,
        async (c) =>
          (await c.query('select 1 from pg_database where datname = $1', [stack.databaseName]))
            .rowCount,
      );
      expect(exists).toBe(0);
      await expect(stack.reset()).rejects.toThrow(TestStackError);
    },
    CONTAINER_TEST_TIMEOUT_MS,
  );

  it(
    'reaps throwaway databases older than the limit, and nothing else (failure mode: stale runs)',
    async () => {
      const servers = await resolveTestServers();
      const nowSeconds = Math.floor(Date.now() / 1000);
      // Past this call's 20-minute limit but within the hour other stacks reap at, so a stack
      // starting in a parallel file cannot drop it first; live stacks are minutes old.
      const limitMs = 20 * 60 * 1000;
      const old = `test_${nowSeconds - 30 * 60}_0bad0bad`;
      const recent = `test_${nowSeconds - 60}_0ccc0ccc`;
      const foreign = 'test_keep_me_please';
      const names = [old, recent, foreign];
      await onServer(servers.databaseUrl, async (c) => {
        for (const name of names) await c.query(`create database ${pg.escapeIdentifier(name)}`);
      });
      try {
        const dropped = await reapStaleTestDatabases(servers.databaseUrl, limitMs);
        expect(dropped).toContain(old);
        expect(dropped).not.toContain(recent);
        expect(dropped).not.toContain(foreign);
        const left = await onServer(servers.databaseUrl, async (c) =>
          (
            await c.query<{ name: string }>(
              'select datname as name from pg_database where datname = any($1)',
              [names],
            )
          ).rows
            .map((r) => r.name)
            .sort(),
        );
        expect(left).toEqual([recent, foreign].sort());
      } finally {
        await onServer(servers.databaseUrl, async (c) => {
          for (const name of names)
            await c.query(`drop database if exists ${pg.escapeIdentifier(name)} with (force)`);
        });
      }
    },
    CONTAINER_TEST_TIMEOUT_MS,
  );
});

async function onServer<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
