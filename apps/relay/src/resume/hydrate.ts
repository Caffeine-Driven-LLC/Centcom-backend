/**
 * Hydration (B042): recovering a session the hot buffer lost (a Redis flush or restart) from the
 * durable log, so `head` and the recent frames are back before anything is sequenced, and a
 * session never starts again at `seq` 1.
 *
 * - `ensure(sid)`: the first time this node sees a session (a connection's handshake, or the
 *   sequence stage's gate), the store's head is read. Head 0 with frames in the durable log means
 *   the session was lost: its newest `RELAY_HYDRATE_FRAMES` frames that form a contiguous run
 *   ending at the log's head (at most HYDRATE_MAX_BYTES of them) go back into the buffer and the
 *   counter is set to the log's head, atomically (`SeqStore.hydrate`). The next frame gets head+1.
 * - A session found sound is remembered (up to MAX_KNOWN_SESSIONS per node); concurrent calls for
 *   one session share one check.
 * - `ready(sid)`: B041's gate. True for a known session; otherwise `ensure`. Recovery that fails
 *   rejects with a 503, so sequencing stays paused for that session (B041 refuses its frames) and
 *   the next frame or connection tries again; `relay_hydrate_failed_total` counts it for alerting.
 *
 * A whole-store flush while connections of a known session stay open is not seen here (the
 * session is remembered): the counter would restart. See README "Limits".
 *
 * Owns: recovery and the known-session memo. Must not: reset a session's numbering, or log `ct`.
 */
import { noopMetrics, unavailable, type Logger, type Metrics } from '@centcom/core';
import { MAX_RANGE } from '../seq/retention.js';
import type { SeqStore, StoredFrame } from '../seq/types.js';
import type { DurableLogReader } from './types.js';

/** Sessions this node remembers as sound, at most (the oldest is forgotten first). */
export const MAX_KNOWN_SESSIONS = 100_000;
/** The most bytes of frames one hydration puts back in the buffer. */
export const HYDRATE_MAX_BYTES = 16 * 1024 * 1024;

/** What the hydrator needs. */
export interface HydratorDeps {
  store: Pick<SeqStore, 'head' | 'hydrate'>;
  durable: DurableLogReader;
  /** RELAY_HYDRATE_FRAMES. */
  frames: number;
  /** The store's buffer cap (RELAY_BUF_MAX_FRAMES): hydration never puts back more. */
  maxBufferFrames: number;
  clock?: () => number;
  logger?: Logger;
  metrics?: Metrics;
  /** Default MAX_KNOWN_SESSIONS. */
  maxKnown?: number;
}

/** Recovery of lost sessions. */
export interface Hydrator {
  /** Recovers the session if it was lost; resolves once it may be sequenced. */
  ensure(sid: string): Promise<void>;
  /** B041's gate: true for a session known sound, else `ensure(sid)`. */
  ready(sid: string): true | Promise<void>;
  /** Sessions remembered (tests). */
  known(): number;
}

/** The hydrator. */
export function createHydrator(deps: HydratorDeps): Hydrator {
  const clock = deps.clock ?? Date.now;
  const metrics = deps.metrics ?? noopMetrics;
  const maxKnown = deps.maxKnown ?? MAX_KNOWN_SESSIONS;
  const limit = Math.min(deps.frames, deps.maxBufferFrames);
  const known = new Set<string>();
  const running = new Map<string, Promise<void>>();

  const remember = (sid: string): void => {
    known.add(sid);
    if (known.size > maxKnown) {
      const oldest = known.values().next().value;
      if (oldest !== undefined) known.delete(oldest);
    }
  };

  /**
   * The newest frames, at most `limit` of them and HYDRATE_MAX_BYTES, when they form a contiguous
   * run ending at `head`; none otherwise (the log reads stop at a gap, so frames after a hole
   * cannot be reached: the head alone is put back, and replays read the log).
   */
  async function tail(sid: string, head: number): Promise<StoredFrame[]> {
    if (limit === 0) return [];
    const run: StoredFrame[] = [];
    let after = Math.max(0, head - limit);
    while (after < head) {
      const page = await deps.durable.range(sid, after, Math.min(MAX_RANGE, head - after));
      const frames = page.filter((f) => f.seq > after && f.seq <= head);
      // The first page may start later (older frames are gone); after that, frames must follow on.
      if (frames.length === 0 || (run.length > 0 && frames[0]?.seq !== after + 1)) return [];
      run.push(...frames);
      after = frames.at(-1)?.seq ?? head;
    }
    let bytes = 0;
    let keep = run.length;
    for (let i = run.length - 1; i >= 0; i -= 1) {
      bytes += Buffer.byteLength(JSON.stringify(run[i]), 'utf8');
      if (bytes > HYDRATE_MAX_BYTES) break;
      keep = i;
    }
    return run.slice(keep);
  }

  async function check(sid: string): Promise<void> {
    try {
      if ((await deps.store.head(sid)) > 0) {
        remember(sid);
        return;
      }
      const head = await deps.durable.maxSeq(sid);
      if (head > 0) {
        const frames = await tail(sid, head);
        const after = await deps.store.hydrate(sid, head, frames, clock());
        metrics.counter('relay_hydrated_total').inc();
        deps.logger?.warn({ sid, head: after, frames: frames.length }, 'relay.session_hydrated');
      }
      remember(sid);
    } catch (err) {
      metrics.counter('relay_hydrate_failed_total').inc();
      deps.logger?.error(
        { sid, error: err instanceof Error ? err.name : typeof err },
        'relay.hydrate_failed',
      );
      throw unavailable(1, 'This session is being recovered; try again shortly.', {
        cause: err instanceof Error ? err : new Error('hydration failed'),
      });
    }
  }

  function ensure(sid: string): Promise<void> {
    if (known.has(sid)) return Promise.resolve();
    let pending = running.get(sid);
    if (pending === undefined) {
      pending = check(sid).finally(() => running.delete(sid));
      running.set(sid, pending);
    }
    return pending;
  }

  return {
    ensure,
    ready: (sid) => (known.has(sid) ? true : ensure(sid)),
    known: () => known.size,
  };
}
