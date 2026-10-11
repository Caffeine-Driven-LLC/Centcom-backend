/**
 * B059 expiry (acceptance 2; failure mode 2): a lock with ttl_ms 5 000 expires at 5 000 ms on the
 * fake clock, the sweep emits exactly one `expire` and the path is free (granted to the first
 * waiter if any); TTLs are clamped to CT-WS-SESSION-EVENTS "Limits" (default 300 000, min 5 000,
 * max 3 600 000; the card's 1 000 / 600 000 bounds are the contract's 5 000 / 3 600 000); the lock
 * key carries the TTL in Redis, so a missed sweep still expires it; an acquire that finds an
 * expired lock frees it first.
 */
import { newId } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import {
  clampTtl,
  LOCK_TTL_DEFAULT_MS,
  LOCK_TTL_MAX_MS,
  LOCK_TTL_MIN_MS,
} from '../../src/locks/ports.js';
import { lock, lockEnv } from './helpers.js';

describe('expiry (acceptance 2)', () => {
  it('ttl 5 000: held at 4 999 ms, one expire at 5 000 ms, then free', async () => {
    const env = lockEnv();
    const a = newId('agt');
    const t0 = env.clock.now;
    await env.send(lock('acquire', 'x', a, 5_000), env.editor);
    env.clock.now = t0 + 4_999;
    expect(await env.service.sweep(new Date(env.clock.now))).toBe(0);
    env.clock.now = t0 + 5_000;
    expect(await env.service.sweep(new Date(env.clock.now))).toBe(1);
    expect(env.recorded.count('relay_lock_expired_total')).toBe(1);
    expect(env.emitted.map((e) => e.p)).toEqual([
      { action: 'expire', path_hmac: 'x', agent_id: a },
    ]);
    expect(await env.service.sweep(new Date(env.clock.now + 1_000))).toBe(0);
    expect(env.emitted).toHaveLength(1);
    const b = newId('agt');
    expect(await env.send(lock('acquire', 'x', b), env.other)).toEqual({ outcome: 'granted' });
  });

  it('an expiry grants the first waiter', async () => {
    const env = lockEnv();
    const [a, b] = [newId('agt'), newId('agt')];
    await env.send(lock('acquire', 'x', a, 5_000), env.editor);
    await env.send(lock('acquire', 'x', b, 7_000), env.other);
    env.clock.now += 5_000;
    await env.service.sweep(new Date(env.clock.now));
    expect(env.emitted.slice(-2).map((e) => e.p)).toEqual([
      { action: 'expire', path_hmac: 'x', agent_id: a },
      { action: 'acquire', path_hmac: 'x', agent_id: b, ttl_ms: 7_000 },
    ]);
  });

  it('an acquire after expiry (before any sweep) frees the stale lock with an expire first', async () => {
    const env = lockEnv();
    const [a, b] = [newId('agt'), newId('agt')];
    await env.send(lock('acquire', 'x', a, 5_000), env.editor);
    env.clock.now += 6_000;
    let expiredFirst = false;
    const emit = env.emitted.length;
    const out = await env.service.handle(
      {
        sid: env.sid,
        sender: env.other,
        sequence: () => {
          // When b's acquire is sequenced, a's expire has already gone out.
          expiredFirst = env.emitted.length === emit + 1;
          return Promise.resolve({ seq: 9 } as never);
        },
      },
      lock('acquire', 'x', b),
    );
    expect(out).toEqual({ outcome: 'granted' });
    expect(expiredFirst).toBe(true);
    expect(env.emitted.at(-1)?.p).toEqual({ action: 'expire', path_hmac: 'x', agent_id: a });
  });

  it('writes the lock key with the TTL, so Redis expires it without a sweep', async () => {
    const env = lockEnv();
    await env.send(lock('acquire', 'x', newId('agt'), 5_000), env.editor);
    expect(await env.redis.kv.ttl(`lock:${env.sid}:x`)).toBe(5_000);
    env.clock.now += 5_001;
    expect(await env.redis.kv.get(`lock:${env.sid}:x`)).toBeNull();
  });
});

describe('clamping (acceptance 2, contract limits)', () => {
  it('clamps to CT-WS-SESSION-EVENTS: default 300 000, min 5 000, max 3 600 000', () => {
    expect([LOCK_TTL_DEFAULT_MS, LOCK_TTL_MIN_MS, LOCK_TTL_MAX_MS]).toEqual([
      300_000, 5_000, 3_600_000,
    ]);
    expect(clampTtl(undefined)).toBe(300_000);
    expect(clampTtl(999)).toBe(5_000);
    expect(clampTtl(4_999)).toBe(5_000);
    expect(clampTtl(600_001)).toBe(600_001);
    expect(clampTtl(3_600_001)).toBe(3_600_000);
    expect(clampTtl(Number.NaN)).toBe(300_000);
  });

  it('a lock asked for 999 ms lives 5 000 ms', async () => {
    const env = lockEnv();
    await env.send(lock('acquire', 'x', newId('agt'), 999), env.editor);
    env.clock.now += 4_999;
    expect(await env.service.sweep(new Date(env.clock.now))).toBe(0);
    env.clock.now += 1;
    expect(await env.service.sweep(new Date(env.clock.now))).toBe(1);
  });
});

describe('sweeping after a restart (failure mode 2)', () => {
  it('a new service sweeps a session it watches, from the stored state', async () => {
    const env = lockEnv();
    const a = newId('agt');
    await env.send(lock('acquire', 'x', a, 5_000), env.editor);
    const { LockService } = await import('../../src/locks/service.js');
    const { createRedisLockStore } = await import('../../src/locks/store.js');
    const emitted: Record<string, unknown>[] = [];
    const restarted = new LockService({
      store: createRedisLockStore({ kv: env.kv, clock: () => env.clock.now }),
      emitter: { emit: (_sid, frames) => (emitted.push(...frames), Promise.resolve()) },
      clock: () => env.clock.now,
    });
    env.clock.now += 5_000;
    expect(await restarted.sweep(new Date(env.clock.now))).toBe(0);
    restarted.watch(env.sid);
    expect(await restarted.sweep(new Date(env.clock.now))).toBe(1);
    expect(emitted).toEqual([{ action: 'expire', path_hmac: 'x', agent_id: a }]);
  });
});
