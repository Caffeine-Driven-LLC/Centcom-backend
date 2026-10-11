/**
 * B057 rebuild from storage (acceptance 7): after a restart (a new registry, Redis emptied) the
 * registry rebuilds from the `agent` table and `list()` returns what it returned before, for 100
 * random agents in random states; a resend of a spawn after the restart is still recognised.
 */
import { newId } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { AgentRegistry } from '../../src/agents/registry.js';
import { createStateRateLimiter } from '../../src/agents/state-rate-limit.js';
import { agentEnv, exit, spawn, state } from './helpers.js';

/** A seeded generator, so a failure repeats. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 2 ** 32;
  };
}

const STATES = ['thinking', 'planning', 'editing-file', 'running-command', 'idle', 'tests-pass'];

describe('rebuild from storage (acceptance 7)', () => {
  it('returns the same list() for 100 random agents after a restart', async () => {
    // A branch session, so editors' own agents and the host's mix.
    const env = agentEnv({ limit: null, mode: 'branch' });
    const random = rng(57);
    const members = [env.host, env.editor, env.other];
    const spawns = [];
    for (let i = 0; i < 100; i++) {
      const owner = members[Math.floor(random() * members.length)] ?? env.host;
      const s = spawn({ owner: owner.memberId, mode: 'branch' });
      spawns.push(s);
      await env.send(s, random() < 0.5 ? owner : env.host);
    }
    for (const s of spawns) {
      env.clock.now += 1_000;
      const roll = random();
      if (roll < 0.3)
        await env.send(
          exit(s.agentId, roll < 0.1 ? 'error' : 'ok', roll < 0.1 ? 'boom' : undefined),
          env.host,
        );
      else if (roll < 0.8) {
        const name = STATES[Math.floor(random() * STATES.length)] ?? 'idle';
        await env.send(state(s.agentId, name, new Date(env.clock.now).toISOString()), env.host);
      }
    }
    const before = env.registry.list(env.sid);
    expect(before).toHaveLength(100);

    // The restart: a new registry, and Redis lost its copy.
    env.store.redis.clear();
    const restarted = new AgentRegistry({
      store: env.store,
      entitlements: { maxParallelAgents: () => Promise.resolve(null) },
      rateLimit: createStateRateLimiter({ store: env.redis.rateLimit, clock: () => env.clock.now }),
      sessions: { modeOf: () => Promise.resolve('branch') },
    });
    expect(restarted.list(env.sid)).toEqual([]);
    expect(await restarted.snapshot(env.sid)).toEqual(before);
    expect(restarted.list(env.sid)).toEqual(before);
    expect(restarted.countLive(env.sid)).toBe(env.registry.countLive(env.sid));
    // Redis was refilled from Postgres on the next locked read.
    await restarted.onState(env.sid, state(newId('agt'), 'idle'), env.host, () =>
      Promise.resolve(undefined),
    );
    expect(env.store.redis.has(env.sid)).toBe(true);
  });

  it('recognises a resend of a spawn after the restart', async () => {
    const env = agentEnv();
    const s = spawn({ owner: env.host.memberId });
    await env.send(s, env.host);
    env.store.redis.clear();
    const restarted = new AgentRegistry({
      store: env.store,
      entitlements: { maxParallelAgents: () => Promise.resolve(8) },
      rateLimit: createStateRateLimiter({ store: env.redis.rateLimit, clock: () => env.clock.now }),
    });
    const step = env.seq.step(s, env.host.memberId);
    expect(await restarted.onSpawn(env.sid, s, env.host, step)).toEqual({ outcome: 'resent' });
    expect(await restarted.snapshot(env.sid)).toHaveLength(1);
  });

  it('rebuilds a corrupted Redis document from Postgres', async () => {
    const env = agentEnv();
    const s = spawn({ owner: env.host.memberId });
    await env.send(s, env.host);
    env.store.redis.set(env.sid, '{"v":1,"agents":[{"agentId":3}]}');
    expect((await env.registry.snapshot(env.sid)).map((a) => a.agentId)).toEqual([s.agentId]);
  });
});
