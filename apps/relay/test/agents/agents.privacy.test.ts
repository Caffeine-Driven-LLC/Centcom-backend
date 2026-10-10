/**
 * B057 privacy (acceptance 8; guardrail: read only the cleartext `p`): the registry never stores
 * or logs label, branch, worktree or model: those keys are absent from the `agent` table (its
 * migration), from the Redis document, from the Postgres rows, and from every log line written
 * while frames carrying them (in `ct`, or wrongly in `p`) went through.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { agentEnv, exit, fixture, spawn, state } from './helpers.js';

const SECRET_KEYS = ['label', 'branch', 'worktree', 'model'];

describe('agent privacy (acceptance 8)', () => {
  it('the agent table has no label, branch, worktree or model column', () => {
    const sql = readFileSync(
      new URL('../../../../packages/db/migrations/20260102004700_agents.sql', import.meta.url),
      'utf8',
    );
    const body = /create table agent \(([\s\S]*?)\n\);/.exec(sql)?.[1] ?? '';
    const columns = body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[a-z][a-z0-9_]* (text|bigint|timestamptz)\b/.test(line))
      .map((line) => line.split(' ')[0]);
    expect(columns).toEqual([
      'session_id',
      'agent_id',
      'owner_member',
      'mode',
      'state',
      'since',
      'spawned_seq',
      'spawn_frame_id',
      'spawned_by',
      'exited_seq',
      'outcome',
      'error_code',
      'rev',
      'updated_at',
    ]);
    for (const key of SECRET_KEYS) expect(columns).not.toContain(key);
  });

  it('stores and logs none of them, even when a client puts them in p', async () => {
    const env = agentEnv({ limit: 1 });
    const secrets = {
      label: 'refactor-billing',
      branch: 'feat/secret-branch',
      worktree: '/home/u/wt',
      model: 'model-x',
    };
    const s = spawn({ owner: env.host.memberId });
    // A misbehaving client puts the secret fields in the cleartext part too.
    Object.assign(s.p as Record<string, unknown>, secrets);
    await env.send(s, env.host);
    await env.send(state(s.agentId, 'thinking'), env.host);
    await env.send(spawn({ owner: env.host.memberId }), env.host); // refused: limit
    env.store.postgresDown = true;
    await env.send(exit(s.agentId), env.host); // logged: save failed
    const stored = JSON.stringify({
      redis: [...env.store.redis.values()],
      postgres: [...env.store.postgres.values()].map((m) => [...m.values()]),
      list: env.registry.list(env.sid),
    });
    const logs = env.captured.raw();
    expect(logs).toContain('agents.save_failed');
    for (const text of [stored, logs]) {
      for (const key of SECRET_KEYS) expect(text).not.toContain(`"${key}"`);
      for (const value of Object.values(secrets)) expect(text).not.toContain(value);
    }
  });

  it('never looks at ct', async () => {
    const env = agentEnv();
    const base = fixture('agent.spawn');
    const s = spawn({ owner: env.host.memberId });
    let read = 0;
    const frame = {
      ...s,
      get ct(): unknown {
        read += 1;
        return base['ct'];
      },
    };
    await env.send(frame, env.host);
    expect(read).toBe(0);
  });
});
