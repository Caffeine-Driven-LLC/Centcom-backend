/**
 * The hot buffer's rules (B041), shared by the Redis store's script and the in-memory store so both
 * keep exactly the same frames: a session's buffer is the contiguous run of its newest frames
 * `oldest..head`, at most `maxFrames` of them, trimmed from the old end after every append.
 *
 * Owns: the constants and the trimming rule. Must not: trim a frame the rule says to keep.
 */
import type { BufferLimits } from './types.js';

/** `(sid, from, id)` is remembered this long (CT-WS-ENVELOPE). */
export const DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * A session's buffer (and its receive times) expire this long after its last frame: a quiet
 * session does not hold up to 20 000 frames in Redis for long. Losing it loses no numbering.
 */
export const BUFFER_TTL_MS = 48 * 60 * 60 * 1000;
/**
 * A session's `seq` counter expires this long after its last frame (31 days, B009's longest TTL,
 * beyond the 30-day `history_days` of any plan), so a live session that stays quiet for days never
 * starts again at 1. Losing it to a Redis flush is B042's to recover (`SeqStore.hydrate` from the
 * durable log).
 */
export const COUNTER_TTL_MS = 31 * 24 * 60 * 60 * 1000;
/** At most this many aged-out frames are trimmed per append (bounds one script's work). */
export const TRIM_STEP = 64;
/** The most frames one `range` call returns. */
export const MAX_RANGE = 1_000;

/**
 * How many of the oldest frames to drop after an append that left `length` frames buffered:
 * first everything over `maxFrames`; then, while more than `minFrames` would remain, the leading
 * frames received before `nowMs - minAgeMs` (`receivedAt(i)` is the time of the i-th oldest
 * frame), looking at no more than TRIM_STEP of them.
 */
export function dropCount(
  length: number,
  receivedAt: (index: number) => number,
  nowMs: number,
  limits: BufferLimits,
): number {
  let drop = Math.max(0, length - limits.maxFrames);
  const room = Math.min(length - drop - limits.minFrames, TRIM_STEP);
  const cutoff = nowMs - limits.minAgeMs;
  for (let i = 0; i < room; i += 1) {
    if (receivedAt(drop) >= cutoff) break;
    drop += 1;
  }
  return drop;
}

/**
 * Throws a RangeError for a `hydrate` call outside the rules: `head` a whole number from 1, and
 * `frames` the contiguous run of frames ending at `head` (none at all is allowed), at most
 * `maxFrames` of them.
 */
export function checkHydrate(
  head: number,
  frames: readonly { seq: number }[],
  limits: Pick<BufferLimits, 'maxFrames'>,
): void {
  if (!Number.isSafeInteger(head) || head < 1) {
    throw new RangeError('hydrate: head must be a whole number from 1');
  }
  if (frames.length > limits.maxFrames) {
    throw new RangeError('hydrate: more frames than the buffer keeps');
  }
  frames.forEach((f, i) => {
    if (f.seq !== head - frames.length + 1 + i) {
      throw new RangeError('hydrate: frames must be the contiguous run ending at head');
    }
  });
}

/** Throws a RangeError for a `range` call outside the rules. */
export function checkRange(afterSeq: number, limit: number): void {
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
    throw new RangeError('range: afterSeq must be a whole number from 0');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RANGE) {
    throw new RangeError(`range: limit must be a whole number from 1 to ${MAX_RANGE}`);
  }
}
