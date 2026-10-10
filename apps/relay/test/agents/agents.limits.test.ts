/**
 * B057 limits: `max_parallel_agents` on spawn (acceptance 3: the pro fixture's 8, refused
 * `forbidden` with a quota detail and not sequenced; an exit frees a place), the state rate limit
 * (acceptance 5: at most 2 per agent per second, identical consecutive states once), and the
 * failure modes (Redis down: spawns refused 503 while state and exit go on; the entitlement read
 * failing: 503).
 */
import { describe, expect, it } from 'vitest';
import { AGENT_DETAILS } from '../../src/agents/registry.js';
import { agentEnv, exit, planLimit, spawn, state } from './helpers.js';

describe('max_parallel_agents (acceptance 3)', () => {
  it('at 8 live agents (pro) the next spawn is forbidden with a quota detail and not sequenced', async () => {
    const env = agentEnv();
    expect(planLimit('pro')).toBe(8);
    const spawned = [];
    for (let i = 0; i < 8; i++) {
      const s = spawn({ owner: env.host.memberId });
      spawned.push(s);
      expect(await env.send(s, env.host)).toMatchObject({ outcome: 'sequenced' });
    }
    expect(env.registry.countLive(env.sid)).toBe(8);
    const ninth = await env.send(spawn({ owner: env.host.memberId }), env.host);
    expect(ninth).toEqual({ outcome: 'refused', code: 'forbidden', detail: AGENT_DETAILS.limit });
    expect(AGENT_DETAILS.limit).toContain('max_parallel_agents');
    expect(env.seq.sequenced).toHaveLength(8);
    expect(env.recorded.count('relay_agent_spawns_refused_total', { reason: 'limit' })).toBe(1);
    await env.send(exit(spawned[0]?.agentId ?? ''), env.host);
    expect(await env.send(spawn({ owner: env.host.memberId }), env.host)).toMatchObject({
      outcome: 'sequenced',
    });
  });

  it('the free plan allows 4, the team plan 16, a null limit any number', async () => {
    for (const [plan, n] of [
      ['free', 4],
      ['team', 16],
    ] as const) {
      const env = agentEnv({ limit: planLimit(plan) });
      for (let i = 0; i < n; i++) await env.send(spawn({ owner: env.host.memberId }), env.host);
      expect(await env.send(spawn({ owner: env.host.memberId }), env.host)).toMatchObject({
        code: 'forbidden',
      });
    }
    const open = agentEnv({ limit: null });
    for (let i = 0; i < 20; i++) await open.send(spawn({ owner: open.host.memberId }), open.host);
    expect(open.registry.countLive(open.sid)).toBe(20);
  });

  it('counts each session separately', async () => {
    const env = agentEnv({ limit: 1 });
    await env.send(spawn({ owner: env.host.memberId }), env.host);
    expect(
      await env.send(spawn({ owner: env.host.memberId }), env.host, 'ses_other'),
    ).toMatchObject({
      outcome: 'sequenced',
    });
  });

  it('concurrent spawns never pass the limit', async () => {
    const env = agentEnv({ limit: 3 });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => env.send(spawn({ owner: env.host.memberId }), env.host)),
    );
    expect(results.filter((r) => r.outcome === 'sequenced')).toHaveLength(3);
    expect(env.registry.countLive(env.sid)).toBe(3);
  });
});

describe('the state rate limit (acceptance 5)', () => {
  it('5 different states in one second: at most 2 sequenced; the next second 2 more', async () => {
    const env = agentEnv();
    const s = spawn({ owner: env.host.memberId });
    await env.send(s, env.host);
    const names = ['thinking', 'planning', 'editing-file', 'reading-file', 'searching'];
    const results = [];
    for (const name of names) results.push(await env.send(state(s.agentId, name), env.host));
    expect(results.filter((r) => r.outcome === 'sequenced')).toHaveLength(2);
    expect(results.filter((r) => r.outcome === 'dropped')).toHaveLength(3);
    expect(env.recorded.count('relay_agent_state_dropped_total', { reason: 'rate' })).toBe(3);
    // Dropped frames get no answer and are not sequenced.
    expect(env.seq.sequenced.filter((f) => f.frame.k === 'agent.state')).toHaveLength(2);
    env.clock.now += 1_000;
    await env.send(state(s.agentId, 'thinking'), env.host);
    await env.send(state(s.agentId, 'saving'), env.host);
    expect(env.seq.sequenced.filter((f) => f.frame.k === 'agent.state')).toHaveLength(4);
  });

  it('two identical consecutive states: one sequenced', async () => {
    const env = agentEnv();
    const s = spawn({ owner: env.host.memberId });
    await env.send(s, env.host);
    expect(await env.send(state(s.agentId, 'thinking'), env.host)).toMatchObject({
      outcome: 'sequenced',
    });
    env.clock.now += 5_000;
    expect(await env.send(state(s.agentId, 'thinking'), env.host)).toEqual({
      outcome: 'dropped',
      reason: 'identical',
    });
    expect(env.recorded.count('relay_agent_state_dropped_total', { reason: 'identical' })).toBe(1);
  });

  it('counts per agent', async () => {
    const env = agentEnv();
    const a = spawn({ owner: env.host.memberId });
    const b = spawn({ owner: env.host.memberId });
    await env.send(a, env.host);
    await env.send(b, env.host);
    for (const name of ['thinking', 'planning']) {
      await env.send(state(a.agentId, name), env.host);
      expect(await env.send(state(b.agentId, name), env.host)).toMatchObject({
        outcome: 'sequenced',
      });
    }
  });
});

describe('failure modes', () => {
  it('Redis down: spawns are refused 503 (fail closed); state and exit go on from Postgres', async () => {
    const env = agentEnv();
    const s = spawn({ owner: env.host.memberId });
    await env.send(s, env.host);
    env.store.redisDown = true;
    expect(await env.send(spawn({ owner: env.host.memberId }), env.host)).toMatchObject({
      outcome: 'refused',
      code: 'service_unavailable',
    });
    expect(await env.send(state(s.agentId, 'thinking'), env.host)).toMatchObject({
      outcome: 'sequenced',
    });
    expect(await env.send(exit(s.agentId), env.host)).toMatchObject({ outcome: 'sequenced' });
    expect(env.store.postgres.get(env.sid)?.get(s.agentId)?.exited).toEqual({ outcome: 'ok' });
    env.store.redisDown = false;
    expect(await env.send(spawn({ owner: env.host.memberId }), env.host)).toMatchObject({
      outcome: 'sequenced',
    });
  });

  it('the entitlement read failing: the spawn is refused 503', async () => {
    const env = agentEnv();
    env.limit.fail = true;
    expect(await env.send(spawn({ owner: env.host.memberId }), env.host)).toMatchObject({
      code: 'service_unavailable',
    });
    expect(env.seq.sequenced).toHaveLength(0);
  });

  it('Postgres down: frames go on from the Redis copy; the failed writes are counted and logged', async () => {
    const env = agentEnv();
    const s = spawn({ owner: env.host.memberId });
    await env.send(s, env.host);
    env.store.postgresDown = true;
    expect(await env.send(state(s.agentId, 'thinking'), env.host)).toMatchObject({
      outcome: 'sequenced',
    });
    expect(env.recorded.count('relay_agent_store_failures_total')).toBe(1);
    expect(env.captured.raw()).toContain('agents.save_failed');
    // A session without a Redis copy cannot be read at all: refused, nothing sequenced.
    await expect(
      env.send(spawn({ owner: env.host.memberId }), env.host, 'ses_cold'),
    ).rejects.toThrow();
  });
});

describe('the store after an outage', () => {
  it('changes made while Redis was down win over its older copy once it returns', async () => {
    const env = agentEnv();
    const s = spawn({ owner: env.host.memberId });
    await env.send(s, env.host);
    env.store.redisDown = true;
    await env.send(exit(s.agentId, 'canceled'), env.host);
    env.store.redisDown = false;
    // Redis still holds the copy from before the exit; the table is newer, so it is rebuilt.
    expect((await env.registry.snapshot(env.sid))[0]?.exited).toEqual({ outcome: 'canceled' });
    expect(await env.send(state(s.agentId, 'thinking'), env.host)).toEqual({
      outcome: 'dropped',
      reason: 'exited',
    });
    expect(env.registry.countLive(env.sid)).toBe(0);
  });

  it('a failed Postgres write is retried with the next save; Redis keeps the change meanwhile', async () => {
    const env = agentEnv();
    await env.send(spawn({ owner: env.host.memberId }), env.host);
    const s = spawn({ owner: env.host.memberId });
    env.store.postgresDown = true;
    expect(await env.send(s, env.host)).toMatchObject({ outcome: 'sequenced' });
    env.store.postgresDown = false;
    expect(env.store.postgres.get(env.sid)?.get(s.agentId)).toBeUndefined();
    expect(env.registry.get(env.sid, s.agentId)).toBeDefined();
    await env.send(spawn({ owner: env.host.memberId }), env.host);
    expect(env.store.postgres.get(env.sid)?.get(s.agentId)).toBeDefined();
  });

  it('a failed Redis write drops its copy, so the next load rebuilds from Postgres', async () => {
    const env = agentEnv();
    const s = spawn({ owner: env.host.memberId });
    await env.send(s, env.host);
    const store = env.store;
    const realSet = store.redis.set.bind(store.redis);
    let failNext = true;
    store.redis.set = (k: string, v: string) => {
      if (failNext) {
        failNext = false;
        throw new Error('redis write failed');
      }
      return realSet(k, v);
    };
    await env.send(exit(s.agentId), env.host);
    expect(store.redis.has(env.sid)).toBe(false);
    expect((await env.registry.snapshot(env.sid))[0]?.exited).toEqual({ outcome: 'ok' });
  });
});

describe('the sliding window (acceptance 5)', () => {
  it('a burst across a second boundary still lets at most 2 through in any second', async () => {
    const env = agentEnv();
    const s = spawn({ owner: env.host.memberId });
    await env.send(s, env.host);
    env.clock.now = Date.parse('2026-10-10T12:00:00.900Z');
    const names = ['thinking', 'planning', 'editing-file', 'reading-file'];
    const results = [];
    for (const name of names) {
      results.push(await env.send(state(s.agentId, name), env.host));
      env.clock.now += 100;
    }
    expect(results.filter((r) => r.outcome === 'sequenced')).toHaveLength(2);
  });
});
