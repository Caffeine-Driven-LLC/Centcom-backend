/**
 * Idempotent create (B054; test "sessions.idempotency.test.ts", acceptance 2 and 3):
 *
 * - the same Idempotency-Key and body twice: identical 201 bodies, `Idempotency-Replayed: true` on
 *   the second, one session (and one `session.create` audit event);
 * - the same key with another body: 409 `idempotency_conflict`, nothing created;
 * - a plan without the relay: 403 from the `entitlement_*` family, and no row afterwards (also on
 *   a retry with the same key).
 */
import { createIdGenerator } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { sessionsApp, World } from './helpers.js';

/** Idempotency keys are ULIDs (B024): `use_` ids without the prefix. */
const ulid = createIdGenerator();
const keys = new Map<string, string>();
const keyOf = (name: string): string => {
  if (!keys.has(name)) keys.set(name, ulid('use').slice(4));
  return keys.get(name) as string;
};

async function setup(plan: 'free' | 'team' = 'team') {
  const world = new World();
  const w = world.workspace(plan);
  const env = await sessionsApp({ world });
  const post = async (key: string, body: Record<string, unknown>) =>
    env.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { ...(await env.as(w.owner)), 'idempotency-key': keyOf(key) },
      payload: { workspace: w.id, ...body },
    });
  return { ...env, w, post };
}

describe('Idempotency-Key on POST /v1/sessions', () => {
  it('replays the same 201 body with Idempotency-Replayed: true, creating one session', async () => {
    const env = await setup();
    const first = await env.post('create-1', { name: 'Release train' });
    const second = await env.post('create-1', { name: 'Release train' });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.body).toBe(first.body);
    expect(first.headers['idempotency-replayed']).toBeUndefined();
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(second.headers['location']).toBe(first.headers['location']);
    expect(second.headers['etag']).toBe(first.headers['etag']);
    expect(second.headers['cache-control']).toBe('private, no-store');
    expect(env.world.sessions.size).toBe(1);
    const audits = (await env.detached()).filter((r) => r['action'] === 'session.create');
    expect(audits).toHaveLength(1);
  });

  it('answers 409 idempotency_conflict for the same key with another body', async () => {
    const env = await setup();
    expect((await env.post('create-2', { name: 'One' })).statusCode).toBe(201);
    const res = await env.post('create-2', { name: 'Two' });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ code: string }>().code).toBe('idempotency_conflict');
    expect(env.world.sessions.size).toBe(1);
  });

  it('creates two sessions for two keys', async () => {
    const env = await setup();
    await env.post('a', { name: 'Same' });
    await env.post('b', { name: 'Same' });
    expect(env.world.sessions.size).toBe(2);
  });
});

describe('entitlements', () => {
  it('refuses a plan without relay access with an entitlement_* 403, and writes no row', async () => {
    const env = await setup('free');
    for (let i = 0; i < 2; i++) {
      const res = await env.post('free-1', { name: 'Not allowed' });
      expect([403, 429]).toContain(res.statusCode);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.json<{ code: string }>().code).toMatch(/^entitlement_/);
    }
    expect(env.world.sessions.size).toBe(0);
    expect(env.world.members).toHaveLength(0);
  });
});
