/**
 * Failure modes (B018): Redis unavailable answers authorize and the token exchange with 503 and
 * `retry_after_s`, issues nothing and falls back to nothing in process; the outage's own message
 * never reaches the response.
 */
import { createMemoryRedis, type KeyValue } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { testClock } from '../tokens/helpers.js';
import {
  authorize,
  authorizeParams,
  exchange,
  failingKv,
  issueCode,
  login,
  newId,
  pkceApp,
  pkcePair,
} from './helpers.js';

/** A KeyValue that works until `broken.on` is set. */
function breakableKv(inner: KeyValue): KeyValue & { broken: { on: boolean } } {
  const broken = { on: false };
  const guard =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> =>
      broken.on ? Promise.reject(new Error('connect ECONNREFUSED 10.0.0.9:6379')) : fn(...args);
  return {
    broken,
    get: guard((key) => inner.get(key)),
    set: guard((key, value, opts) => inner.set(key, value, opts)),
    setIfAbsent: guard((key, value, ttl) => inner.setIfAbsent(key, value, ttl)),
    del: guard((key) => inner.del(key)),
    incr: guard((key, ttl) => inner.incr(key, ttl)),
    ttl: guard((key) => inner.ttl(key)),
  };
}

describe('Redis unavailable', () => {
  it('answers authorize with 503 and retry_after_s', async () => {
    const h = await pkceApp({
      kv: failingKv(() => new Error('connect ECONNREFUSED 10.0.0.9:6379')),
    });
    const res = await authorize(
      h.app,
      authorizeParams(pkcePair().challenge),
      'centcom_sid=' + 'a'.repeat(43),
    );
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      code: 'service_unavailable',
      retry_after_s: expect.any(Number),
    });
    expect(res.headers['location']).toBeUndefined();
    expect(res.body).not.toContain('ECONNREFUSED');
    await h.app.close();
  });

  it('answers authorize with 503 when the code cannot be stored', async () => {
    const clock = testClock();
    const kv = breakableKv(createMemoryRedis(clock.now).kv);
    const h = await pkceApp({ kv, clock });
    const cookie = await login(h.app, newId('usr'));
    const params = authorizeParams(pkcePair().challenge);
    // The session read works; the code write fails.
    const failing = kv.set;
    let calls = 0;
    kv.set = (...args) => {
      calls += 1;
      return calls === 1 ? failing(...args) : Promise.reject(new Error('READONLY'));
    };
    const res = await authorize(h.app, params, cookie);
    expect(res.statusCode).toBe(503);
    expect(res.headers['location']).toBeUndefined();
    await h.app.close();
  });

  it('answers the token exchange with 503 and issues nothing', async () => {
    const clock = testClock();
    const kv = breakableKv(createMemoryRedis(clock.now).kv);
    const h = await pkceApp({ kv, clock });
    const pair = pkcePair();
    const { code } = await issueCode(h.app, authorizeParams(pair.challenge));
    kv.broken.on = true;
    const res = await exchange(h.app, {
      code,
      verifier: pair.verifier,
      redirectUri: 'http://127.0.0.1:53682/callback',
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      code: 'service_unavailable',
      retry_after_s: expect.any(Number),
    });
    expect(res.json()).not.toHaveProperty('access_token');
    expect([...h.store.rows.values()]).toHaveLength(0);
    await h.app.close();
  });
});
