/**
 * The Redis SeqStore on a real Redis 7 (B041; REDIS_URL in CI's integration job, a container in
 * its test job, skipped where neither is available): the Lua script stays atomic under 20 parallel
 * clients (gapless seq, one winner for a raced id), the hot-buffer suite passes as in memory, keys
 * carry the prefix, the session hash tag and their TTLs, an evicted script, counter or times list
 * is recovered from, and the stage runs end to end on it. Without Redis at all (any machine): every
 * call is a 503 within the command timeout, and the stage answers `sys.error` plus `sys.slow_down`.
 */
import { newId } from '@centcom/contracts';
import { isAppError, Secret } from '@centcom/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stampFrame } from '../../src/seq/frame.js';
import { createRedisSeqStore, createSeqRedisClient, seqKeys } from '../../src/seq/redis-store.js';
import { BUFFER_TTL_MS, COUNTER_TTL_MS, DEDUPE_TTL_MS } from '../../src/seq/retention.js';
import { SEQ_METRICS } from '../../src/seq/stage.js';
import { appendFrames, defineBufferSuite, frameAt } from './buffer-suite.js';
import { clientFrame, LIMITS, reaction, sentOf, T0, unitSequencer } from './helpers.js';
import { REDIS, REDIS_TIMEOUT_MS, startRedisHarness, type RedisHarness } from './redis-helpers.js';

describe.runIf(REDIS)('the Redis SeqStore', () => {
  let redis: RedisHarness;
  beforeAll(async () => {
    redis = await startRedisHarness();
  }, REDIS_TIMEOUT_MS);
  afterAll(async () => {
    await redis.cleanup();
  });

  defineBufferSuite('Redis 7', (limits) => Promise.resolve(redis.store(limits).store), 120_000);

  it(
    'assigns 1..1000 exactly once to 1 000 frames from 20 parallel clients (the script is atomic)',
    async () => {
      const prefix = redis.prefix();
      const stores = Array.from({ length: 20 }, () =>
        createRedisSeqStore(redis.client(prefix), LIMITS),
      );
      const sid = newId('ses');
      const results = await Promise.all(
        stores.flatMap((store) =>
          Array.from({ length: 50 }, () => {
            const { key, frame } = frameAt(sid, T0);
            return store.assign(sid, key, frame, T0);
          }),
        ),
      );
      expect(results.every((r) => !r.duplicate)).toBe(true);
      expect(results.map((r) => r.seq).sort((a, b) => a - b)).toEqual(
        Array.from({ length: 1_000 }, (_, i) => i + 1),
      );
      const [store] = stores;
      if (store === undefined) throw new Error('no store');
      expect(await store.head(sid)).toBe(1_000);
      expect(await store.oldest(sid)).toBe(1);
      const all = [...(await store.range(sid, 0, 1_000))];
      expect(all.map((f) => f.seq)).toEqual(Array.from({ length: 1_000 }, (_, i) => i + 1));
    },
    REDIS_TIMEOUT_MS,
  );

  it(
    'gives one seq to a frame 20 clients submit at once; the others are duplicates of it',
    async () => {
      const prefix = redis.prefix();
      const sid = newId('ses');
      const { key, frame } = frameAt(sid, T0);
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          createRedisSeqStore(redis.client(prefix), LIMITS).assign(sid, key, frame, T0),
        ),
      );
      expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
      expect(new Set(results.map((r) => r.seq))).toEqual(new Set([1]));
      expect(new Set(results.map((r) => r.ts))).toEqual(new Set([frame.ts]));
    },
    REDIS_TIMEOUT_MS,
  );

  it(
    'writes its keys under the prefix with the session hash tag, every one with its TTL',
    async () => {
      const { store, prefix } = redis.store(LIMITS);
      const sid = newId('ses');
      const { key, frame } = frameAt(sid, T0);
      await store.assign(sid, key, frame, T0);
      const keys = seqKeys(sid);
      const raw = (k: string): string => `${prefix}${k}`;
      expect(new Set(await redis.admin.keys(`${prefix}*`))).toEqual(
        new Set([
          raw(keys.seq),
          raw(keys.buf),
          raw(keys.times),
          raw(keys.dedupe(key.from, key.id)),
        ]),
      );
      expect(raw(keys.seq)).toBe(`${prefix}relay:ses:{${sid}}:seq`);
      for (const k of [keys.buf, keys.times]) {
        const ttl = await redis.admin.pttl(raw(k));
        expect(ttl).toBeGreaterThan(BUFFER_TTL_MS - 60_000);
        expect(ttl).toBeLessThanOrEqual(BUFFER_TTL_MS);
      }
      const counterTtl = await redis.admin.pttl(raw(keys.seq));
      expect(counterTtl).toBeGreaterThan(COUNTER_TTL_MS - 60_000);
      expect(counterTtl).toBeLessThanOrEqual(COUNTER_TTL_MS);
      const dedupe = raw(keys.dedupe(key.from, key.id));
      const ttl = await redis.admin.pttl(dedupe);
      expect(ttl).toBeGreaterThan(DEDUPE_TTL_MS - 60_000);
      expect(ttl).toBeLessThanOrEqual(DEDUPE_TTL_MS);
      expect(await redis.admin.get(dedupe)).toBe(`1|${frame.ts}`);
      expect(await redis.admin.xlen(raw(keys.buf))).toBe(await redis.admin.llen(raw(keys.times)));
    },
    REDIS_TIMEOUT_MS,
  );

  it(
    'reloads its script after SCRIPT FLUSH (NOSCRIPT)',
    async () => {
      const { store } = redis.store(LIMITS);
      const sid = newId('ses');
      await appendFrames(store, sid, 2, () => T0, 1);
      await redis.admin.script('FLUSH');
      await appendFrames(store, sid, 1, () => T0, 1);
      expect(await store.head(sid)).toBe(3);
    },
    REDIS_TIMEOUT_MS,
  );

  it(
    'goes on after the newest buffered frame when its counter was lost, never from 1',
    async () => {
      const { store, prefix } = redis.store(LIMITS);
      const sid = newId('ses');
      await appendFrames(store, sid, 5, () => T0, 1);
      await redis.admin.del(`${prefix}${seqKeys(sid).seq}`);
      // head and oldest read the lost counter from the buffer, as the script does.
      expect(await store.head(sid)).toBe(5);
      expect(await store.oldest(sid)).toBe(1);
      await appendFrames(store, sid, 1, () => T0, 1);
      expect(await store.head(sid)).toBe(6);
      expect((await store.range(sid, 0, 10)).map((f) => f.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    },
    REDIS_TIMEOUT_MS,
  );

  it(
    'rebuilds a lost times list (unknown ages count as now) and keeps trimming by the rules',
    async () => {
      const limits = { minFrames: 3, minAgeMs: 1_000, maxFrames: 10 };
      const { store, prefix } = redis.store(limits);
      const sid = newId('ses');
      const times = `${prefix}${seqKeys(sid).times}`;
      const buf = `${prefix}${seqKeys(sid).buf}`;
      await appendFrames(store, sid, 6, (i) => T0 + i, 1);
      await redis.admin.del(times);
      await appendFrames(store, sid, 1, () => T0 + 10, 1);
      expect(await redis.admin.llen(times)).toBe(await redis.admin.xlen(buf));
      expect(await redis.admin.xlen(buf)).toBe(7);
      // Every frame now counts as received at T0 + 10: an append 2 s later trims to the floor.
      await appendFrames(store, sid, 1, () => T0 + 2_010, 1);
      expect(await store.oldest(sid)).toBe(6);
      expect(await redis.admin.llen(times)).toBe(3);
      // A times list longer than the buffer is cut back to it.
      await redis.admin.rpush(times, '1', '2', '3');
      await appendFrames(store, sid, 1, () => T0 + 2_011, 1);
      expect(await redis.admin.llen(times)).toBe(await redis.admin.xlen(buf));
    },
    REDIS_TIMEOUT_MS,
  );

  it(
    'runs the stage end to end: echo, dedupe and the buffer on Redis',
    async () => {
      const { store } = redis.store(LIMITS);
      const unit = unitSequencer({ store });
      const sid = newId('ses');
      const member = unit.join(sid);
      const frame = clientFrame(sid);
      const first = await unit.inbound(member, frame);
      const again = await unit.inbound(member, { ...frame });
      expect(first.stored?.seq).toBe(1);
      expect(again.passed).toBe(false);
      const echoes = sentOf(member, 'event');
      expect(echoes).toHaveLength(2);
      expect(JSON.stringify(echoes[1])).toBe(JSON.stringify(echoes[0]));
      expect(JSON.stringify((await store.range(sid, 0, 1))[0])).toBe(JSON.stringify(echoes[0]));
    },
    REDIS_TIMEOUT_MS,
  );
});

describe('when Redis is down', () => {
  const client = createSeqRedisClient({
    url: new Secret('redis://127.0.0.1:1'),
    keyPrefix: 'ct:test:',
    commandTimeoutMs: 200,
    connectTimeoutMs: 200,
  });
  const store = createRedisSeqStore(client, LIMITS);
  afterAll(() => {
    client.disconnect();
  });

  it('rejects every call with a 503 within the command timeout, nothing hanging', async () => {
    const sid = newId('ses');
    const from = newId('mem');
    const id = newId('msg');
    const frame = stampFrame({ t: 'event', id, k: 'reaction', p: reaction() }, from, 'ts', sid);
    const started = Date.now();
    for (const call of [
      store.assign(sid, { from, id }, frame, T0),
      store.head(sid),
      store.range(sid, 0, 10),
      store.oldest(sid),
    ]) {
      const err = await call.then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(isAppError(err) && err.code === 'service_unavailable' && err.status === 503).toBe(
        true,
      );
    }
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  it('the stage refuses the frame with sys.error service_unavailable and sys.slow_down, keeps the connection, sequences nothing', async () => {
    const unit = unitSequencer({ store });
    const sid = newId('ses');
    const member = unit.join(sid);
    const frame = clientFrame(sid);
    const { passed } = await unit.inbound(member, frame);
    expect(passed).toBe(false);
    const [error, slow] = member.sent();
    expect(error).toMatchObject({
      t: 'sys.error',
      ref: frame['id'],
      p: { code: 'service_unavailable', status: 503, retry_after_s: 1 },
    });
    expect(slow).toEqual({ v: 1, t: 'sys.slow_down', p: { for_ms: 1_000, reason: 'rate' } });
    expect(member.events.some((e) => e.kind === 'close')).toBe(false);
    expect(unit.recorded.count(SEQ_METRICS.sequenced, { outcome: 'unavailable' })).toBe(1);
  }, 20_000);
});
