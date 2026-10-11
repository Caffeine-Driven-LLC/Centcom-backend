/**
 * B057 on Postgres 16 and Redis (CI's integration job, or containers): the Redis store with its
 * Postgres write-through round-trips agents, rebuilds a lost Redis copy from the `agent` table
 * (acceptance 7), serialises two writers of one session through the Redis lock, degrades to
 * Postgres when Redis is unreachable, refuses rows that break the table's rules, and the
 * entitlement read finds the plan's `max_parallel_agents`.
 */
import { newId } from '@centcom/contracts';
import { createRedis, Secret, type RedisBackend } from '@centcom/core';
import { createFactories } from '@centcom/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresAgentEntitlements } from '../../src/agents/entitlements.js';
import type { StoredAgent } from '../../src/agents/ports.js';
import { AgentRegistry } from '../../src/agents/registry.js';
import { createStateRateLimiter } from '../../src/agents/state-rate-limit.js';
import { createRedisAgentStore, type AgentsDb } from '../../src/agents/store.js';
import type { AccessDbClient } from '../../src/rooms/access.js';
import { STACK, STACK_TIMEOUT_MS, startTestStack, type TestStack } from '../slots/helpers.js';
import { exit, sequencer, spawn, state } from './helpers.js';

const agent = (over: Partial<StoredAgent> = {}): StoredAgent => ({
  agentId: newId('agt'),
  owner: newId('mem'),
  mode: 'branch',
  state: 'thinking',
  since: '2026-10-10T12:00:00Z',
  spawnedSeq: 1,
  spawnFrameId: newId('msg'),
  spawnedBy: newId('mem'),
  ...over,
});

describe.runIf(STACK)('agents on Postgres 16 and Redis', () => {
  let stack: TestStack;
  let redis: RedisBackend;
  let db: AgentsDb;
  let f: ReturnType<typeof createFactories>;

  beforeAll(async () => {
    stack = await startTestStack();
    redis = createRedis({ url: new Secret(stack.redisUrl), keyPrefix: stack.redisKeyPrefix });
    db = stack.db as unknown as AgentsDb;
    f = createFactories(stack.db);
  }, STACK_TIMEOUT_MS);
  afterAll(async () => {
    await redis?.close();
    await stack?.stop();
  });

  const session = async () => {
    const workspace = await f.workspaces.create();
    return {
      workspace,
      session: await f.sessions.create({ workspace: workspace.id, state: 'live' }),
    };
  };

  it('writes through to Postgres and rebuilds a lost Redis copy (acceptance 7)', async () => {
    const { session: s } = await session();
    const store = createRedisAgentStore({ kv: redis.kv, db });
    const a = agent({ spawnedSeq: 3 });
    const b = agent({
      spawnedSeq: 4,
      exited: { outcome: 'error', errorCode: 'crash' },
      exitedSeq: 9,
    });
    await store.withSession(s.id, async (tx) => {
      const agents = await tx.load();
      expect(agents.size).toBe(0);
      agents.set(a.agentId, a);
      agents.set(b.agentId, b);
      await tx.save(agents, [a.agentId, b.agentId]);
    });
    const rows = await db
      .selectFrom('agent')
      .select(['agent_id', 'since', 'exited_seq'])
      .where('session_id', '=', s.id)
      .orderBy('spawned_seq')
      .execute();
    expect(rows).toEqual([
      { agent_id: a.agentId, since: '2026-10-10T12:00:00Z', exited_seq: null },
      { agent_id: b.agentId, since: '2026-10-10T12:00:00Z', exited_seq: '9' },
    ]);
    const before = await store.read(s.id);
    await redis.kv.del(`relay:agents:${s.id}`);
    expect(await store.read(s.id)).toEqual(before);
    await store.withSession(s.id, async (tx) => {
      expect([...(await tx.load()).values()]).toEqual([...before.values()]);
    });
    expect(await redis.kv.get(`relay:agents:${s.id}`)).not.toBeNull();
  });

  it('serialises two writers of one session', async () => {
    const { session: s } = await session();
    const stores = [
      createRedisAgentStore({ kv: redis.kv, db }),
      createRedisAgentStore({ kv: redis.kv, db }),
    ];
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        (stores[i % 2] ?? stores[0])?.withSession(s.id, async (tx) => {
          const agents = await tx.load();
          const a = agent({ spawnedSeq: i + 1 });
          agents.set(a.agentId, a);
          await tx.save(agents, [a.agentId]);
        }),
      ),
    );
    expect((await stores[0]?.read(s.id))?.size).toBe(10);
  });

  it('degrades to Postgres when Redis is unreachable', async () => {
    const { session: s } = await session();
    const down = {
      get: () => Promise.reject(new Error('redis down')),
      set: () => Promise.reject(new Error('redis down')),
      setIfAbsent: () => Promise.reject(new Error('redis down')),
      del: () => Promise.reject(new Error('redis down')),
    };
    const store = createRedisAgentStore({ kv: down, db });
    const a = agent();
    await store.withSession(s.id, async (tx) => {
      expect(tx.degraded).toBe(true);
      const agents = await tx.load();
      agents.set(a.agentId, a);
      await tx.save(agents, [a.agentId]);
    });
    expect([...(await store.read(s.id)).keys()]).toEqual([a.agentId]);
  });

  it('refuses rows that break the table rules', async () => {
    const { session: s } = await session();
    const base = {
      session_id: s.id,
      agent_id: newId('agt'),
      owner_member: newId('mem'),
      mode: 'branch',
      state: 'idle',
      since: 'x',
      spawned_seq: 1,
      spawn_frame_id: newId('msg'),
      spawned_by: newId('mem'),
    };
    await db
      .insertInto('agent')
      .values(base as never)
      .execute();
    for (const bad of [
      { ...base, agent_id: newId('agt'), spawned_by: 'mem_nope' },
      { ...base, agent_id: 'agt_nope' },
      { ...base, agent_id: newId('agt'), mode: 'solo' },
      { ...base, agent_id: newId('agt'), outcome: 'ok' },
      { ...base, agent_id: newId('agt'), exited_seq: 3 },
      { ...base, agent_id: newId('agt'), session_id: newId('ses') },
    ]) {
      await expect(
        db
          .insertInto('agent')
          .values(bad as never)
          .execute(),
      ).rejects.toThrow();
    }
  });

  it("reads the plan's max_parallel_agents (free 4 without a subscription)", async () => {
    const { session: s } = await session();
    const entitlements = createPostgresAgentEntitlements({
      db: stack.db as unknown as AccessDbClient,
      clock: Date.now,
    });
    expect(await entitlements.maxParallelAgents(s.id)).toBe(4);
  });

  it('rebuilds the same list() for 100 random agents from the agent table (acceptance 7)', async () => {
    const { session: s } = await session();
    const clock = { now: Date.parse('2026-01-01T00:00:00.000Z') };
    const seq = sequencer(clock);
    const registryOn = () =>
      new AgentRegistry({
        store: createRedisAgentStore({ kv: redis.kv, db }),
        entitlements: { maxParallelAgents: () => Promise.resolve(null) },
        rateLimit: createStateRateLimiter({ store: redis.rateLimit, clock: () => clock.now }),
      });
    const before = registryOn();
    const host = { memberId: newId('mem'), role: 'host' as const };
    let x = 7;
    const random = () => (x = (x * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) {
      const f = spawn({ owner: host.memberId });
      ids.push(f.agentId);
      await before.onSpawn(s.id, f, host, seq.step(f, host.memberId));
    }
    for (const id of ids) {
      clock.now += 1_000;
      const roll = random();
      const f =
        roll < 0.3 ? exit(id, 'error', 'boom') : state(id, roll < 0.6 ? 'thinking' : 'idle');
      const step = seq.step(f, host.memberId);
      if (f.k === 'agent.exit') await before.onExit(s.id, f, host, step);
      else await before.onState(s.id, f, host, step);
    }
    const listed = before.list(s.id);
    expect(listed).toHaveLength(100);
    await redis.kv.del(`relay:agents:${s.id}`);
    const after = registryOn();
    expect(await after.snapshot(s.id)).toEqual(listed);
  }, 60_000);

  it('a copy older than the table (written while Redis was down) is rebuilt', async () => {
    const { session: s } = await session();
    const store = createRedisAgentStore({ kv: redis.kv, db });
    const a = agent();
    await store.withSession(s.id, async (tx) => {
      const agents = await tx.load();
      agents.set(a.agentId, a);
      await tx.save(agents, [a.agentId]);
    });
    const down = {
      get: () => Promise.reject(new Error('redis down')),
      set: () => Promise.reject(new Error('redis down')),
      setIfAbsent: () => Promise.reject(new Error('redis down')),
      del: () => Promise.reject(new Error('redis down')),
    };
    await createRedisAgentStore({ kv: down, db }).withSession(s.id, async (tx) => {
      const agents = await tx.load();
      agents.set(a.agentId, { ...a, exited: { outcome: 'canceled' }, exitedSeq: 2 });
      await tx.save(agents, [a.agentId]);
    });
    expect((await store.read(s.id)).get(a.agentId)?.exited).toEqual({ outcome: 'canceled' });
  });

  it('has no label, branch, worktree or model column (acceptance 8)', async () => {
    const cols = await db
      .selectFrom('information_schema.columns' as never)
      .select('column_name' as never)
      .where('table_name' as never, '=', 'agent' as never)
      .execute();
    const names = (cols as { column_name: string }[]).map((c) => c.column_name).sort();
    for (const key of ['label', 'branch', 'worktree', 'model']) expect(names).not.toContain(key);
    expect(names).toContain('spawned_by');
  });
});
