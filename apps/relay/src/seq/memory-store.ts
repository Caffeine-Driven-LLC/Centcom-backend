/**
 * An in-memory SeqStore (B041) with the Redis store's rules step for step: the dedupe record, the
 * gapless `seq`, the buffer and its trimming (`retention.ts`). For tests and tools on one process;
 * the relay never sequences without Redis, because a second, local order would fork the session.
 *
 * Owns: per-process copies of the counters, buffers and dedupe records. Must not: be used by a
 * relay serving clients.
 */
import { seqParts, parseStoredFrame } from './frame.js';
import { checkHydrate, checkRange, DEDUPE_TTL_MS, dropCount } from './retention.js';
import type { AssignResult, BufferLimits, SeqStore, StoredFrame } from './types.js';

interface Buffer {
  head: number;
  /** Stored JSON, oldest first, from index `start`. */
  frames: string[];
  /** Receive time of each frame (ms). */
  times: number[];
  start: number;
}

/** What the in-memory store adds for tests. */
export interface MemorySeqStore extends SeqStore {
  /** Buffered frames of `sid`. */
  size(sid: string): number;
  /** Dedupe records held (expired ones are swept on assign). */
  dedupeRecords(): number;
}

/** A SeqStore in this process. */
export function createMemorySeqStore(limits: BufferLimits): MemorySeqStore {
  const buffers = new Map<string, Buffer>();
  /** `sid\u0000from\u0000id` to the original `seq` and `ts`, in insertion (time) order. */
  const seen = new Map<string, { seq: number; ts: string; expiresAt: number }>();

  const bufferOf = (sid: string): Buffer => {
    let buffer = buffers.get(sid);
    if (buffer === undefined) {
      buffer = { head: 0, frames: [], times: [], start: 0 };
      buffers.set(sid, buffer);
    }
    return buffer;
  };
  const length = (b: Buffer): number => b.frames.length - b.start;

  const sweep = (nowMs: number): void => {
    for (const [key, record] of seen) {
      if (record.expiresAt > nowMs) break;
      seen.delete(key);
    }
  };

  const trim = (b: Buffer, nowMs: number): void => {
    const drop = dropCount(length(b), (i) => b.times[b.start + i] ?? nowMs, nowMs, limits);
    b.start += drop;
    // Compact once the dropped prefix is large, so trimming stays O(1) on average.
    if (b.start > 4_096 && b.start * 2 > b.frames.length) {
      b.frames = b.frames.slice(b.start);
      b.times = b.times.slice(b.start);
      b.start = 0;
    }
  };

  const store: MemorySeqStore = {
    assign(sid, key, frame, nowMs): Promise<AssignResult> {
      sweep(nowMs);
      const dedupeKey = `${sid}\u0000${key.from}\u0000${key.id}`;
      const original = seen.get(dedupeKey);
      if (original !== undefined && original.expiresAt > nowMs) {
        return Promise.resolve({ seq: original.seq, duplicate: true, ts: original.ts });
      }
      const b = bufferOf(sid);
      b.head += 1;
      const seq = b.head;
      const { prefix, suffix } = seqParts(frame);
      b.frames.push(`${prefix}${seq}${suffix}`);
      b.times.push(nowMs);
      trim(b, nowMs);
      seen.delete(dedupeKey);
      seen.set(dedupeKey, { seq, ts: frame.ts, expiresAt: nowMs + DEDUPE_TTL_MS });
      return Promise.resolve({ seq, duplicate: false, ts: frame.ts });
    },
    head: (sid) => Promise.resolve(buffers.get(sid)?.head ?? 0),
    range(sid, afterSeq, limit): Promise<StoredFrame[]> {
      try {
        checkRange(afterSeq, limit);
      } catch (err) {
        return Promise.reject(err as RangeError);
      }
      const b = buffers.get(sid);
      if (b === undefined || length(b) === 0) return Promise.resolve([]);
      const oldest = b.head - length(b) + 1;
      const from = Math.max(afterSeq + 1, oldest);
      const out: StoredFrame[] = [];
      for (let seq = from; seq <= b.head && out.length < limit; seq += 1) {
        out.push(parseStoredFrame(b.frames[b.start + (seq - oldest)] as string));
      }
      return Promise.resolve(out);
    },
    oldest(sid) {
      const b = buffers.get(sid);
      if (b === undefined || length(b) === 0) return Promise.resolve(null);
      return Promise.resolve(b.head - length(b) + 1);
    },
    hydrate(sid, head, frames, nowMs): Promise<number> {
      try {
        checkHydrate(head, frames, limits);
      } catch (err) {
        return Promise.reject(err as RangeError);
      }
      const b = bufferOf(sid);
      if (b.head >= head) return Promise.resolve(b.head);
      b.head = head;
      b.frames = frames.map((f) => JSON.stringify(f));
      b.times = frames.map(() => nowMs);
      b.start = 0;
      return Promise.resolve(head);
    },
    size: (sid) => {
      const b = buffers.get(sid);
      return b === undefined ? 0 : length(b);
    },
    dedupeRecords: () => seen.size,
    async assignBatch(sid, items, nowMs): Promise<AssignResult[]> {
      // One turn of this process: nothing else is sequenced in between.
      const results: Promise<AssignResult>[] = [];
      for (const { key, frame } of items) results.push(store.assign(sid, key, frame, nowMs));
      return Promise.all(results);
    },
  };
  return store;
}
