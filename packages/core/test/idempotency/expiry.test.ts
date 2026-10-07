/**
 * Expiry (B024, card test expiry.test.ts; acceptance 6): a response replays for 24 hours (still at
 * 23 h 59 m, gone at 24 h), and the lock of a request whose process died frees its key after 30 s.
 * In memory, on a fake clock (Redis TTLs run in real time).
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createMemoryRedis, LOCK_TTL_MS, RECORD_TTL_MS, storeKeyFor } from '../../src/index.js';
import { FakeClock } from '../redis/helpers.js';
import { fp, jsonResponse, quickStore } from './helpers.js';

const KEY = storeKeyFor(null, 'POST', '/v1/things', randomUUID());

describe('expiry', () => {
  it('replays for 24 hours, then treats the key as new (acceptance 6)', async () => {
    const clock = new FakeClock();
    const kv = createMemoryRedis(clock.read).kv;
    const store = quickStore(kv, { clock: clock.read });
    await store.claim(KEY, fp({}));
    await store.complete(KEY, fp({}), jsonResponse(201, { n: 1 }));
    clock.advance(RECORD_TTL_MS - 60_000);
    expect((await store.claim(KEY, fp({}))).kind).toBe('replay');
    clock.advance(60_000);
    expect(await store.claim(KEY, fp({}))).toEqual({ kind: 'claimed' });
    expect(RECORD_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("frees a dead request's key after 30 seconds", async () => {
    const clock = new FakeClock();
    const kv = createMemoryRedis(clock.read).kv;
    await quickStore(kv).claim(KEY, fp({}));
    clock.advance(LOCK_TTL_MS - 1);
    expect(await quickStore(kv, { inFlightWaitMs: 20 }).claim(KEY, fp({}))).toEqual({
      kind: 'in_flight',
    });
    clock.advance(1);
    expect(await quickStore(kv).claim(KEY, fp({}))).toEqual({ kind: 'claimed' });
    expect(LOCK_TTL_MS).toBe(30_000);
  });

  it('stamps records with the store clock', async () => {
    const clock = new FakeClock();
    const kv = createMemoryRedis(clock.read).kv;
    const store = quickStore(kv, { clock: clock.read });
    await store.claim(KEY, fp({}));
    expect(JSON.parse((await kv.get(KEY)) ?? '{}')).toMatchObject({
      state: 'running',
      at: clock.now,
    });
    clock.advance(5);
    await store.complete(KEY, fp({}), jsonResponse(200, {}));
    expect(JSON.parse((await kv.get(KEY)) ?? '{}')).toMatchObject({ state: 'done', at: clock.now });
  });
});
