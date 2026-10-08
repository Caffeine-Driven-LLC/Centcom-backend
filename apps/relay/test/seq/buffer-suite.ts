/**
 * The hot buffer's rules (B041 acceptance 6), as one suite every SeqStore must pass: the in-memory
 * store here (`seq.buffer.test.ts`) and the Redis store on a real Redis
 * (`seq.redis.integration.test.ts`). Frames are appended with explicit receive times, so the age
 * rule is exercised without waiting.
 */
import { newId } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { seqParts, stampFrame, withSeq } from '../../src/seq/frame.js';
import { MAX_RANGE, TRIM_STEP } from '../../src/seq/retention.js';
import type { BufferLimits, SeqStore, StoredFrame, UnsequencedFrame } from '../../src/seq/types.js';
import { LIMITS, reaction, T0 } from './helpers.js';

/** A store under test, with its limits. */
export type OpenStore = (limits: BufferLimits) => Promise<SeqStore>;

const MINUTE = 60_000;

/** A frame from a fresh member, received at `at`. */
export function frameAt(
  sid: string,
  at: number,
): { key: { from: string; id: string }; frame: UnsequencedFrame } {
  const from = newId('mem');
  const id = newId('msg');
  return {
    key: { from, id },
    frame: stampFrame(
      { t: 'event', id, k: 'reaction', p: reaction() },
      from,
      new Date(at).toISOString(),
      sid,
    ),
  };
}

/** Appends `count` frames to `sid`, the i-th received at `at(i)`, `batch` at a time. */
export async function appendFrames(
  store: SeqStore,
  sid: string,
  count: number,
  at: (i: number) => number,
  batch = 500,
): Promise<void> {
  for (let start = 0; start < count; start += batch) {
    const calls: Promise<unknown>[] = [];
    for (let i = start; i < Math.min(count, start + batch); i += 1) {
      const { key, frame } = frameAt(sid, at(i));
      calls.push(store.assign(sid, key, frame, at(i)));
    }
    await Promise.all(calls);
  }
}

/**
 * The buffer as `head` and `oldest` report it, with its size counted by reading every frame
 * through `range` (independently of `oldest`): the frames must run without a gap from `oldest`
 * to `head`.
 */
async function window(
  store: SeqStore,
  sid: string,
): Promise<{ head: number; oldest: number | null; size: number }> {
  const head = await store.head(sid);
  const oldest = await store.oldest(sid);
  const seqs: number[] = [];
  for (let after = 0; ;) {
    const page = await store.range(sid, after, MAX_RANGE);
    if (page.length === 0) break;
    for (const frame of page) seqs.push(frame.seq);
    after = page.at(-1)?.seq ?? after;
  }
  if (seqs.length > 0) {
    expect(seqs[0]).toBe(oldest);
    expect(seqs.at(-1)).toBe(head);
    expect(seqs.every((seq, i) => i === 0 || seq === (seqs[i - 1] ?? 0) + 1)).toBe(true);
  } else {
    expect(oldest).toBeNull();
  }
  return { head, oldest, size: seqs.length };
}

/** Defines the hot-buffer suite for the store `open` gives. */
export function defineBufferSuite(label: string, open: OpenStore, timeoutMs = 60_000): void {
  describe(`the hot buffer (${label})`, () => {
    it(
      'after 30 000 appends within 5 minutes holds the newest 20 000 (the cap), oldest = head - size + 1',
      async () => {
        const store = await open(LIMITS);
        const sid = newId('ses');
        await appendFrames(store, sid, 30_000, (i) => T0 + i * 10);
        const { head, oldest, size } = await window(store, sid);
        expect(head).toBe(30_000);
        expect(size).toBe(20_000);
        expect(oldest).toBe(head - size + 1);
        const first = await store.range(sid, 0, 3);
        expect(first.map((f) => f.seq)).toEqual([10_001, 10_002, 10_003]);
      },
      timeoutMs,
    );

    it(
      'after 30 000 appends over an hour keeps between 5 000 and 20 000, every frame of the last 10 minutes among them',
      async () => {
        const store = await open(LIMITS);
        const sid = newId('ses');
        const spacing = 120; // 30 000 frames over 3 600 s
        await appendFrames(store, sid, 30_000, (i) => T0 + i * spacing);
        const { head, oldest, size } = await window(store, sid);
        expect(size).toBeGreaterThanOrEqual(5_000);
        expect(size).toBeLessThanOrEqual(20_000);
        expect(oldest).toBe(head - size + 1);
        // Frame i is seq i + 1, received at T0 + i * spacing; the last 10 minutes start at i = 24 999.
        const firstYoung = 29_999 - LIMITS.minAgeMs / spacing + 1;
        expect(oldest).toBeLessThanOrEqual(firstYoung);
      },
      timeoutMs,
    );

    it(
      'keeps every frame younger than 10 minutes while the count stays within 20 000',
      async () => {
        const store = await open(LIMITS);
        const sid = newId('ses');
        await appendFrames(store, sid, 15_000, (i) => T0 + i * 20); // 5 minutes
        expect(await window(store, sid)).toEqual({ head: 15_000, oldest: 1, size: 15_000 });
      },
      timeoutMs,
    );

    it(
      'trims frames older than 10 minutes down to 5 000, TRIM_STEP per append, never below the floor',
      async () => {
        const store = await open(LIMITS);
        const sid = newId('ses');
        await appendFrames(store, sid, 15_000, (i) => T0 + i);
        const later = T0 + 11 * MINUTE;
        // One append drops at most TRIM_STEP aged frames.
        await appendFrames(store, sid, 1, () => later);
        expect((await window(store, sid)).size).toBe(15_001 - TRIM_STEP);
        await appendFrames(store, sid, 199, (i) => later + 1 + i, 1);
        const { head, oldest, size } = await window(store, sid);
        expect(head).toBe(15_200);
        expect(size).toBe(5_000);
        expect(oldest).toBe(10_201);
      },
      timeoutMs,
    );

    it(
      'with a zero age floor keeps only the newest RELAY_BUF_MIN_FRAMES',
      async () => {
        const store = await open({ minFrames: 10, minAgeMs: 0, maxFrames: 100 });
        const sid = newId('ses');
        await appendFrames(store, sid, 50, (i) => T0 + i, 1);
        expect(await window(store, sid)).toEqual({ head: 50, oldest: 41, size: 10 });
      },
      timeoutMs,
    );

    it(
      'reads frames after a seq in order, up to a limit, from the oldest kept',
      async () => {
        const store = await open({ minFrames: 5, minAgeMs: 0, maxFrames: 5 });
        const sid = newId('ses');
        expect(await store.range(sid, 0, 10)).toEqual([]);
        expect(await store.oldest(sid)).toBeNull();
        expect(await store.head(sid)).toBe(0);
        await appendFrames(store, sid, 12, (i) => T0 + i, 1);
        expect((await store.range(sid, 0, 100)).map((f) => f.seq)).toEqual([8, 9, 10, 11, 12]);
        expect((await store.range(sid, 9, 2)).map((f) => f.seq)).toEqual([10, 11]);
        expect(await store.range(sid, 12, 10)).toEqual([]);
        expect(await store.range(sid, 99, 10)).toEqual([]);
        await expect(store.range(sid, -1, 10)).rejects.toThrow(RangeError);
        await expect(store.range(sid, 0, 0)).rejects.toThrow(RangeError);
        await expect(store.range(sid, 0, MAX_RANGE + 1)).rejects.toThrow(RangeError);
      },
      timeoutMs,
    );

    it(
      'returns each frame exactly as stamped: ct, sig and p byte-identical (100 random frames)',
      async () => {
        const store = await open(LIMITS);
        const sid = newId('ses');
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
        let seed = 7;
        const random = (): number => {
          seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
          return seed / 2_147_483_648;
        };
        const text = (n: number): string =>
          Array.from({ length: n }, () => alphabet[Math.floor(random() * alphabet.length)]).join(
            '',
          );
        const expected: StoredFrame[] = [];
        for (let i = 0; i < 100; i += 1) {
          const from = newId('mem');
          const id = newId('msg');
          const frame = stampFrame(
            {
              t: 'event',
              id,
              k: 'message.user',
              ct: {
                alg: 'xchacha20poly1305',
                kid: `k${i}`,
                n: text(32),
                c: text(1 + Math.floor(random() * 400)),
              },
              sig: text(86),
              ...(i % 3 === 0
                ? { p: { note: text(20), nested: { list: [1, 'two', null, true] } } }
                : {}),
              ...(i % 5 === 0 ? { ref: newId('msg') } : {}),
            },
            from,
            new Date(T0 + i).toISOString(),
            sid,
          );
          const { seq } = await store.assign(sid, { from, id }, frame, T0 + i);
          expected.push(withSeq(frame, seq));
          const { prefix, suffix } = seqParts(frame);
          expect(`${prefix}${seq}${suffix}`).toBe(JSON.stringify(withSeq(frame, seq)));
        }
        const read = await store.range(sid, 0, 100);
        expect(read.map((f) => JSON.stringify(f))).toEqual(expected.map((f) => JSON.stringify(f)));
      },
      timeoutMs,
    );
  });
}
