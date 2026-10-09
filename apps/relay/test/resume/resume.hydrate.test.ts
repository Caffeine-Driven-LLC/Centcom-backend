/**
 * Hydration after a Redis flush (B042; tests "resume.hydrate.test.ts", acceptance 8, guardrail "MUST
 * NOT restart seq from 1", failure mode "Hydration fails"): a session whose store is empty while
 * the durable log holds 1..300 is recovered by its first connection: the head equals the log's max
 * seq, the newest RELAY_HYDRATE_FRAMES frames are back in the buffer (the same bytes), and the next
 * frame gets 301. Sequencing waits for the recovery on a node that never saw the session; a
 * recovery that fails pauses the session's sequencing (503, `relay_hydrate_failed_total`) until
 * the log is back. `SeqStore.hydrate` passes the same suite on the in-memory store and on Redis.
 */
import { newId } from '@centcom/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHydrator, HYDRATE_MAX_BYTES } from '../../src/resume/hydrate.js';
import { createMemorySeqStore } from '../../src/seq/memory-store.js';
import type { SeqStore, StoredFrame } from '../../src/seq/types.js';
import { recordingMetrics } from '../helpers.js';
import { LIMITS, T0 } from '../seq/helpers.js';
import {
  REDIS,
  REDIS_TIMEOUT_MS,
  startRedisHarness,
  type RedisHarness,
} from '../seq/redis-helpers.js';
import { defineHydrateSuite, framesOf } from './hydrate-suite.js';
import { memoryLog, resumedOf, resumeUnit, seqsOf, type MemoryLog } from './helpers.js';

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** A session's log of 1..n (what the durable log kept before the flush). */
async function logOf(n: number): Promise<{ log: MemoryLog; sid: string; frames: StoredFrame[] }> {
  const log = memoryLog();
  const sid = newId('ses');
  const frames = framesOf(sid, 1, n);
  for (const f of frames) await log.append(sid, f);
  return { log, sid, frames };
}

describe('recovery after a flush (acceptance 8)', () => {
  it('the first connection hydrates: head = the log max, recent frames back, next seq head+1', async () => {
    const { log, sid, frames } = await logOf(300);
    // A relay (and Redis) that lost everything: an empty store, the same durable log.
    const u = resumeUnit({ log, sid, hydrateFrames: 100 });
    expect(await u.store.head(sid)).toBe(0);
    const { conn } = await u.connect(null);
    await u.settled(conn);
    expect(await u.store.head(sid)).toBe(300);
    expect(await u.store.oldest(sid)).toBe(201);
    const buffered = await u.store.range(sid, 200, 1000);
    expect(buffered.map((f) => JSON.stringify(f))).toEqual(
      frames.slice(200).map((f) => JSON.stringify(f)),
    );
    expect((await u.send(conn))?.seq).toBe(301);
    expect(seqsOf(conn)).toEqual([301]);
  });

  it('a resuming client is then replayed from the recovered buffer', async () => {
    const { log, sid } = await logOf(300);
    const u = resumeUnit({ log, sid, hydrateFrames: 100 });
    const { conn, welcome } = await u.connect(250);
    await u.settled(conn);
    expect(welcome).toEqual({ from_seq: 251, to_seq: 300 });
    expect(seqsOf(conn)).toEqual(range(251, 300));
    expect(resumedOf(conn)).toEqual([{ from_seq: 251, to_seq: 300, count: 50 }]);
  });

  it('sequencing on a node that never saw the session waits for the recovery', async () => {
    const { log, sid } = await logOf(300);
    const u = resumeUnit({ log, sid });
    // Already connected (no handshake on this node since the flush): its first frame recovers.
    const member = u.join();
    expect((await u.send(member))?.seq).toBe(301);
    expect(await u.store.head(sid)).toBe(301);
  });

  it('a session new to the log starts at 1, and is checked once', async () => {
    const log = memoryLog();
    const u = resumeUnit({ log });
    const member = u.join();
    expect((await u.send(member))?.seq).toBe(1);
    const reads = log.reads;
    expect((await u.send(member))?.seq).toBe(2);
    expect(log.reads).toBe(reads);
    expect(u.hydrator.known()).toBe(1);
  });
});

describe('when recovery fails', () => {
  it('pauses the session (503, nothing sequenced) and counts it, until the log is back', async () => {
    const { log, sid } = await logOf(300);
    const recorded = recordingMetrics();
    const store = createMemorySeqStore(LIMITS);
    const hydrator = createHydrator({
      store,
      durable: log,
      frames: 100,
      maxBufferFrames: LIMITS.maxFrames,
      metrics: recorded.metrics,
    });
    log.failing = true;
    await expect(hydrator.ensure(sid)).rejects.toMatchObject({
      code: 'service_unavailable',
      retryAfterS: 1,
    });
    expect(recorded.count('relay_hydrate_failed_total')).toBe(1);
    expect(await store.head(sid)).toBe(0);

    const u = resumeUnit({ log, sid });
    const member = u.join();
    expect(await u.send(member)).toBeUndefined();
    expect(member.frames().at(-1)).toMatchObject({
      t: 'sys.slow_down',
    });
    expect(member.frames().find((f) => f['t'] === 'sys.error')).toMatchObject({
      p: { code: 'service_unavailable' },
    });
    expect(await u.store.head(sid)).toBe(0);
    log.failing = false;
    u.advance(2_000);
    expect((await u.send(member))?.seq).toBe(301);
  });

  it('a handshake whose recovery fails is refused (the prepare rejects)', async () => {
    const { log, sid } = await logOf(10);
    const u = resumeUnit({ log, sid });
    log.failing = true;
    await expect(u.connect(5)).rejects.toMatchObject({ code: 'service_unavailable' });
  });
});

describe('what is put back', () => {
  async function hydrateFrom(log: MemoryLog, sid: string, frames = 5_000, maxKnown?: number) {
    const store = createMemorySeqStore(LIMITS);
    const hydrator = createHydrator({
      store,
      durable: log,
      frames,
      maxBufferFrames: LIMITS.maxFrames,
      ...(maxKnown === undefined ? {} : { maxKnown }),
    });
    await hydrator.ensure(sid);
    return { store, hydrator };
  }

  it('the head alone when the newest frames have a hole (the log cannot be read past it)', async () => {
    const { log, sid } = await logOf(300);
    const holed = memoryLog();
    for (const f of log.frames(sid)) if (f.seq !== 290) await holed.append(sid, f);
    const { store } = await hydrateFrom(holed, sid);
    expect(await store.head(sid)).toBe(300);
    expect(await store.oldest(sid)).toBeNull();
  });

  it('the newest frames when older ones are gone', async () => {
    const { log, sid } = await logOf(300);
    log.drop(sid, 250);
    const { store } = await hydrateFrom(log, sid, 100);
    expect(await store.head(sid)).toBe(300);
    expect(await store.oldest(sid)).toBe(251);
  });

  it('nothing but the head when RELAY_HYDRATE_FRAMES is 0', async () => {
    const { log, sid } = await logOf(50);
    const { store } = await hydrateFrom(log, sid, 0);
    expect(await store.head(sid)).toBe(50);
    expect(await store.oldest(sid)).toBeNull();
  });

  it(`at most ${HYDRATE_MAX_BYTES} bytes of frames`, async () => {
    const log = memoryLog();
    const sid = newId('ses');
    const big = 'x'.repeat(220_000);
    for (const f of framesOf(sid, 1, 80)) {
      await log.append(sid, { ...f, ct: { alg: 'xchacha20poly1305', kid: 'k1', n: 'n', c: big } });
    }
    const { store } = await hydrateFrom(log, sid);
    const oldest = (await store.oldest(sid)) as number;
    const kept = 80 - oldest + 1;
    expect(kept).toBeLessThan(80);
    expect(kept * 220_000).toBeLessThanOrEqual(HYDRATE_MAX_BYTES);
    expect((kept + 1) * 220_000).toBeGreaterThan(HYDRATE_MAX_BYTES - 80 * 1_000);
  });

  it('shares one check between concurrent callers and remembers a bounded number of sessions', async () => {
    const log = memoryLog();
    const store = createMemorySeqStore(LIMITS);
    let heads = 0;
    const counting: Pick<SeqStore, 'head' | 'hydrate'> = {
      head: (sid) => {
        heads += 1;
        return store.head(sid);
      },
      hydrate: (...args) => store.hydrate(...args),
    };
    const hydrator = createHydrator({
      store: counting,
      durable: log,
      frames: 10,
      maxBufferFrames: 100,
      maxKnown: 2,
    });
    const sid = newId('ses');
    await Promise.all([hydrator.ensure(sid), hydrator.ensure(sid), hydrator.ensure(sid)]);
    expect(heads).toBe(1);
    expect(hydrator.ready(sid)).toBe(true);
    await hydrator.ensure(newId('ses'));
    await hydrator.ensure(newId('ses'));
    expect(hydrator.known()).toBe(2);
    expect(hydrator.ready(sid)).not.toBe(true);
  });
});

describe('SeqStore.hydrate', () => {
  defineHydrateSuite('memory', (limits) => Promise.resolve(createMemorySeqStore(limits)));
});

describe.runIf(REDIS)('SeqStore.hydrate on Redis', () => {
  let redis: RedisHarness;
  beforeAll(async () => {
    redis = await startRedisHarness();
  }, REDIS_TIMEOUT_MS);
  afterAll(async () => {
    await redis.cleanup();
  });

  defineHydrateSuite('Redis 7', (limits) => Promise.resolve(redis.store(limits).store), 120_000);

  it('recovers a session after its keys were flushed', async () => {
    const { store, prefix } = redis.store(LIMITS);
    const sid = newId('ses');
    const frames = framesOf(sid, 1, 120);
    expect(await store.hydrate(sid, 120, frames, T0)).toBe(120);
    // A flush: every key of the store gone.
    const keys = await redis.admin.keys(`${prefix}*`);
    await redis.admin.del(...keys);
    expect(await store.head(sid)).toBe(0);
    const log = memoryLog();
    for (const f of frames) await log.append(sid, f);
    const hydrator = createHydrator({
      store,
      durable: log,
      frames: 50,
      maxBufferFrames: LIMITS.maxFrames,
    });
    await hydrator.ensure(sid);
    expect(await store.head(sid)).toBe(120);
    expect(await store.oldest(sid)).toBe(71);
    const ttl = await redis.admin.pttl(`${prefix}relay:ses:{${sid}}:seq`);
    expect(ttl).toBeGreaterThan(0);
  }, 120_000);
});
