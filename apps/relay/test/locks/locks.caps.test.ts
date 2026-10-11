/**
 * B059 caps (acceptance 4): waiters are granted FIFO; the 11th waiter for a path is denied (not
 * queued); the 501st lock of a session and the 101st of an agent are denied; Redis down is a
 * 503-class refusal, never an unsynchronised grant (failure mode 1); conflict hints go to B061's
 * port.
 */
import { newId } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { MAX_LOCKS_PER_AGENT, MAX_LOCKS_PER_SESSION, MAX_WAITERS } from '../../src/locks/ports.js';
import { lock, lockEnv } from './helpers.js';

describe('caps (acceptance 4)', () => {
  it('grants waiters FIFO, and denies the 11th', async () => {
    const env = lockEnv();
    const holder = newId('agt');
    await env.send(lock('acquire', 'x', holder), env.editor);
    const waiters = Array.from({ length: MAX_WAITERS }, () => newId('agt'));
    for (const [i, w] of waiters.entries()) {
      expect(await env.send(lock('acquire', 'x', w), env.other)).toEqual({
        outcome: 'queued',
        position: i + 1,
      });
    }
    expect(await env.send(lock('acquire', 'x', newId('agt')), env.other)).toEqual({
      outcome: 'denied',
      holder,
      reason: 'queue_full',
    });
    expect(env.recorded.count('relay_lock_denials_total', { reason: 'queue_full' })).toBe(1);
    // Releases hand the path down the queue in order.
    let current = holder;
    for (const w of waiters) {
      const by = current === holder ? env.editor : env.other;
      await env.send(lock('release', 'x', current), by);
      expect(env.sequenced.at(-1)?.frame['p']).toMatchObject({ action: 'acquire', agent_id: w });
      current = w;
    }
  });

  it('denies the 501st lock of a session', async () => {
    const env = lockEnv();
    expect(MAX_LOCKS_PER_SESSION).toBe(500);
    for (let i = 0; i < MAX_LOCKS_PER_SESSION; i++) {
      await env.send(lock('acquire', `p${i}`, newId('agt')), env.editor);
    }
    const agent = newId('agt');
    expect(await env.send(lock('acquire', 'p500', agent), env.editor)).toEqual({
      outcome: 'denied',
      holder: null,
      reason: 'session_cap',
    });
    expect(env.emitted.at(-1)?.p).toEqual({ action: 'deny', path_hmac: 'p500', agent_id: agent });
  }, 60_000);

  it('denies the 101st lock of an agent', async () => {
    const env = lockEnv();
    const a = newId('agt');
    for (let i = 0; i < MAX_LOCKS_PER_AGENT; i++)
      await env.send(lock('acquire', `p${i}`, a), env.editor);
    expect(await env.send(lock('acquire', 'p100', a), env.editor)).toMatchObject({
      outcome: 'denied',
      reason: 'agent_cap',
    });
    expect(await env.send(lock('acquire', 'p100', newId('agt')), env.editor)).toEqual({
      outcome: 'granted',
    });
  }, 60_000);

  it('Redis down: a 503-class refusal, nothing granted', async () => {
    const env = lockEnv();
    env.down.on = true;
    expect(await env.send(lock('acquire', 'x', newId('agt')), env.editor)).toMatchObject({
      outcome: 'refused',
      code: 'service_unavailable',
    });
    expect(env.sequenced).toHaveLength(0);
  });

  it('tells B061 who holds a contested path', async () => {
    const env = lockEnv();
    const [a, b] = [newId('agt'), newId('agt')];
    await env.send(lock('acquire', 'x', a), env.editor);
    await env.send(lock('acquire', 'x', b), env.other);
    expect(env.hints).toEqual([{ pathHmac: 'x', holder: a, requester: b }]);
  });
});

describe('consistency (failure mode 1; guardrail: no two holders)', () => {
  it('a failed save is a 503 with nothing sequenced, and grants nobody else', async () => {
    const env = lockEnv();
    const [a, b] = [newId('agt'), newId('agt')];
    const realSet = env.kv.set.bind(env.kv);
    let fail = true;
    env.kv.set = (k, v, o) => {
      if (fail && k.startsWith('locks:') && !k.endsWith(':mutex'))
        return Promise.reject(new Error('set failed'));
      return realSet(k, v, o);
    };
    expect(await env.send(lock('acquire', 'x', a), env.editor)).toMatchObject({
      outcome: 'refused',
      code: 'service_unavailable',
    });
    expect(env.sequenced).toHaveLength(0);
    fail = false;
    expect(await env.send(lock('acquire', 'x', b), env.other)).toEqual({ outcome: 'granted' });
  });

  it('a frame sequencing refused changes nothing and is not remembered: its resend is handled', async () => {
    const env = lockEnv();
    const a = newId('agt');
    const frame = lock('acquire', 'x', a);
    let refuse = true;
    const send = () =>
      env.service.handle(
        {
          sid: env.sid,
          sender: env.editor,
          sequence: () => Promise.resolve(refuse ? undefined : ({ seq: 1 } as never)),
        },
        frame,
      );
    expect(await send()).toEqual({ outcome: 'ignored' });
    expect(await env.redis.kv.get(`lock:${env.sid}:x`)).toBeNull();
    refuse = false;
    expect(await send()).toEqual({ outcome: 'granted' });
  });

  it('records the wait of a granted waiter (relay_lock_wait_ms)', async () => {
    const observed: number[] = [];
    const env = lockEnv({
      metrics: {
        counter: () => ({ inc: () => undefined }),
        histogram: (name) => ({
          observe: (v: number) => {
            if (name === 'relay_lock_wait_ms') observed.push(v);
          },
        }),
      },
    });
    const [a, b] = [newId('agt'), newId('agt')];
    await env.send(lock('acquire', 'x', a), env.editor);
    await env.send(lock('acquire', 'x', b), env.other);
    env.clock.now += 1_500;
    await env.send(lock('release', 'x', a), env.editor);
    expect(observed).toEqual([1_500]);
  });

  it('skips a waiter whose agent reached its cap, denying it, and grants the next', async () => {
    const env = lockEnv();
    const capped = newId('agt');
    const next = newId('agt');
    const holder = newId('agt');
    await env.send(lock('acquire', 'x', holder), env.editor);
    await env.send(lock('acquire', 'x', capped), env.other);
    await env.send(lock('acquire', 'x', next), env.host);
    for (let i = 0; i < MAX_LOCKS_PER_AGENT; i++)
      await env.send(lock('acquire', `c${i}`, capped), env.other);
    await env.send(lock('release', 'x', holder), env.editor);
    expect(env.sequenced.slice(-2).map((s) => s.frame['p'])).toEqual([
      { action: 'deny', path_hmac: 'x', agent_id: capped },
      { action: 'acquire', path_hmac: 'x', agent_id: next, ttl_ms: 300_000 },
    ]);
  }, 60_000);
});
