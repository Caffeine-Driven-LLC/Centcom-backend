/**
 * Idempotency and rate limits (B074 acceptance 1 and 7, failure mode "idempotency store down"):
 * without `Idempotency-Key` the answer is 400 `idempotency_key_required` before anything runs; a
 * replay with the same key and body answers the stored response with `Idempotency-Replayed: true`
 * and stores nothing new; the same key with another body is 409; with the idempotency store down
 * the route fails closed with 503. Each device may call it 60 times a minute: the 61st is 429 with
 * `Retry-After` and `RateLimit-*`, and another device is not affected.
 */
import { randomUUID } from 'node:crypto';
import type { KeyValue } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { usageApp, usageEvents } from './helpers.js';

const URL = '/v1/usage/events';

describe('Idempotency-Key', () => {
  it('is required: 400 idempotency_key_required, nothing stored', async () => {
    const ctx = await usageApp();
    const d = await ctx.device();
    ctx.memory.personal(d.userId);
    const response = await ctx.app.inject({
      method: 'POST',
      url: URL,
      headers: d.headers(null),
      payload: { events: usageEvents(3) },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('idempotency_key_required');
    expect(ctx.memory.rows.size).toBe(0);
    await ctx.app.close();
  });

  it('replays the stored response for the same key and body, storing nothing new', async () => {
    const ctx = await usageApp();
    const d = await ctx.device();
    ctx.memory.personal(d.userId);
    const key = randomUUID();
    const payload = { events: usageEvents(5) };
    const first = await ctx.app.inject({
      method: 'POST',
      url: URL,
      headers: d.headers(key),
      payload,
    });
    expect(first.json()).toEqual({ accepted: 5, duplicates: 0 });
    let inserts = 0;
    ctx.memory.failWith(() => {
      inserts += 1;
      return undefined;
    });
    const replay = await ctx.app.inject({
      method: 'POST',
      url: URL,
      headers: d.headers(key),
      payload,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json()).toEqual(first.json());
    expect(inserts).toBe(0);
    expect(ctx.memory.rows.size).toBe(5);
    const other = await ctx.app.inject({
      method: 'POST',
      url: URL,
      headers: d.headers(key),
      payload: { events: usageEvents(1) },
    });
    expect(other.statusCode).toBe(409);
    expect(other.json<{ code: string }>().code).toBe('idempotency_conflict');
    await ctx.app.close();
  });

  it('fails closed with 503 when the idempotency store is down', async () => {
    const down = (): Promise<never> => Promise.reject(new Error('redis down'));
    const kv: KeyValue = {
      get: down,
      set: down,
      setIfAbsent: down,
      del: down,
      incr: down,
      ttl: down,
    };
    const ctx = await usageApp(undefined, { kv });
    const d = await ctx.device();
    ctx.memory.personal(d.userId);
    const response = await ctx.app.inject({
      method: 'POST',
      url: URL,
      headers: d.headers(),
      payload: { events: usageEvents(2) },
    });
    expect(response.statusCode).toBe(503);
    expect(ctx.memory.rows.size).toBe(0);
    await ctx.app.close();
  });
});

describe('the per-device rate limit', () => {
  it('answers the 61st request in a minute with 429, Retry-After and RateLimit-*', async () => {
    const ctx = await usageApp();
    const d = await ctx.device();
    ctx.memory.personal(d.userId);
    const send = () =>
      ctx.app.inject({
        method: 'POST',
        url: URL,
        headers: d.headers(),
        payload: { events: usageEvents(1) },
      });
    for (let i = 0; i < 60; i += 1) {
      const ok = await send();
      expect(ok.statusCode, `request ${i + 1}`).toBe(200);
      expect(ok.headers['ratelimit-limit']).toBe('60');
    }
    const limited = await send();
    expect(limited.statusCode).toBe(429);
    expect(limited.json<{ code: string }>().code).toBe('rate_limited');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.headers['ratelimit-remaining']).toBe('0');
    expect(limited.headers['ratelimit-reset']).toBeDefined();
    // Another device of another user still gets through.
    const other = await ctx.device();
    ctx.memory.personal(other.userId);
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: URL,
          headers: other.headers(),
          payload: { events: usageEvents(1) },
        })
      ).statusCode,
    ).toBe(200);
    await ctx.app.close();
  });
});
