/**
 * `SeqStore.hydrate` (B042, acceptance 8 at the store), as one suite every store must pass: the
 * in-memory store and the Redis store on a real Redis (`resume.hydrate.test.ts`). A session the
 * store lost gets its head back and exactly the frames given (as the same bytes), and the next
 * `seq` is head+1; a store already at the head or beyond keeps everything; calls outside the rules
 * are RangeErrors.
 */
import { newId } from '@centcom/contracts';
import { expect, it } from 'vitest';
import { stampFrame, withSeq } from '../../src/seq/frame.js';
import type { BufferLimits, SeqStore, StoredFrame } from '../../src/seq/types.js';
import { LIMITS, reaction, T0 } from '../seq/helpers.js';

/** A store under test. */
export type OpenStore = (limits: BufferLimits) => Promise<SeqStore>;

/** Frames `from..to` of `sid`, as the durable log returns them. */
export function framesOf(sid: string, from: number, to: number): StoredFrame[] {
  const member = newId('mem');
  return Array.from({ length: to - from + 1 }, (_, i) =>
    withSeq(
      stampFrame(
        { t: 'event', id: newId('msg'), k: 'reaction', p: reaction() },
        member,
        new Date(T0 + i).toISOString(),
        sid,
      ),
      from + i,
    ),
  );
}

const next = (store: SeqStore, sid: string, now = T0) => {
  const from = newId('mem');
  const id = newId('msg');
  return store.assign(
    sid,
    { from, id },
    stampFrame({ t: 'event', id, k: 'reaction', p: reaction() }, from, 'ts', sid),
    now,
  );
};

/** Registers the suite's tests for `open`. */
export function defineHydrateSuite(label: string, open: OpenStore, timeoutMs = 60_000): void {
  it(
    `${label}: puts back the head and the frames; the next seq is head+1`,
    async () => {
      const store = await open(LIMITS);
      const sid = newId('ses');
      const frames = framesOf(sid, 901, 1000);
      expect(await store.hydrate(sid, 1000, frames, T0)).toBe(1000);
      expect(await store.head(sid)).toBe(1000);
      expect(await store.oldest(sid)).toBe(901);
      const back = await store.range(sid, 900, 1000);
      expect(back.map((f) => JSON.stringify(f))).toEqual(frames.map((f) => JSON.stringify(f)));
      expect((await next(store, sid)).seq).toBe(1001);
      expect(await store.oldest(sid)).toBe(901);
    },
    timeoutMs,
  );

  it(
    `${label}: with no frames, the head alone`,
    async () => {
      const store = await open(LIMITS);
      const sid = newId('ses');
      expect(await store.hydrate(sid, 42, [], T0)).toBe(42);
      expect(await store.oldest(sid)).toBeNull();
      expect((await next(store, sid)).seq).toBe(43);
      expect(await store.oldest(sid)).toBe(43);
    },
    timeoutMs,
  );

  it(
    `${label}: keeps a session already at the head or beyond`,
    async () => {
      const store = await open(LIMITS);
      const sid = newId('ses');
      for (let i = 0; i < 5; i += 1) await next(store, sid);
      const before = await store.range(sid, 0, 10);
      expect(await store.hydrate(sid, 3, framesOf(sid, 1, 3), T0)).toBe(5);
      expect(await store.hydrate(sid, 5, framesOf(sid, 5, 5), T0)).toBe(5);
      expect(await store.range(sid, 0, 10)).toEqual(before);
      expect((await next(store, sid)).seq).toBe(6);
    },
    timeoutMs,
  );

  it(
    `${label}: refuses calls outside the rules`,
    async () => {
      const store = await open({ ...LIMITS, minFrames: 10, maxFrames: 10 });
      const sid = newId('ses');
      await expect(store.hydrate(sid, 0, [], T0)).rejects.toThrow(RangeError);
      await expect(store.hydrate(sid, 10, framesOf(sid, 1, 9), T0)).rejects.toThrow(RangeError);
      const gapped = [...framesOf(sid, 7, 8), ...framesOf(sid, 10, 10)];
      await expect(store.hydrate(sid, 10, gapped, T0)).rejects.toThrow(RangeError);
      await expect(store.hydrate(sid, 20, framesOf(sid, 9, 20), T0)).rejects.toThrow(RangeError);
      expect(await store.head(sid)).toBe(0);
    },
    timeoutMs,
  );
}
