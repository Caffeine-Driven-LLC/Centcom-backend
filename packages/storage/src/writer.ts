/**
 * The history writer (B055): receives each sequenced frame from the relay and batches it into the
 * durable log.
 *
 * - `add(sid, frame)` resolves once the frame is durable (`stored`), or at once for a frame the
 *   log never keeps (`skipped`: presence, sys, acks). The relay must not count a frame as durable
 *   before its promise resolves; until then it stays in the hot buffer.
 * - A batch per session is written when it reaches `maxFrames` (500) or `maxDelayMs` (2 s) after
 *   its first frame, whichever comes first.
 * - A failed write is retried up to `attempts` (5) times, waiting `base · 2^n` ms (with jitter:
 *   between half and all of it); then every waiting `add` rejects, `history_append_failures_total`
 *   counts it and the relay keeps the frames.
 * - A frame of an encrypted kind that carries a non-empty `p` is refused (`HistoryFrameRefused`),
 *   counted in `history_frames_refused_total{reason}` and logged with its kind and session only:
 *   it could hold plaintext.
 *
 * Owns: batching, retries and the durability promise. Must not: log `ct` or `p`, or resolve a
 * frame before it is stored.
 */
import { setTimeout as sleepFor } from 'node:timers/promises';
import { noopMetrics, type Logger, type Metrics } from '@centcom/core';
import type { HistoryStore, StoredFrame } from './ports.js';
import { toStoredFrame, type RejectReason, type SequencedFrame } from './store.js';

/** Frames per batch, at most (card B055). */
export const BATCH_MAX_FRAMES = 500;
/** A batch is written at most this long after its first frame (card B055). */
export const BATCH_MAX_DELAY_MS = 2_000;
/** Write attempts per batch, the first included. */
export const APPEND_ATTEMPTS = 5;
/** The first retry waits about this long; each later one about twice as long. */
export const APPEND_BACKOFF_BASE_MS = 200;

/** A frame the log refuses to keep. */
export class HistoryFrameRefused extends Error {
  override name = 'HistoryFrameRefused';
  constructor(readonly reason: Exclude<RejectReason, 'ephemeral'>) {
    super(`history refuses the frame: ${reason}`);
  }
}

/** A timer that can be cancelled. */
export interface WriterTimer {
  cancel(): void;
}

/** What the writer needs. */
export interface HistoryWriterDeps {
  store: Pick<HistoryStore, 'append'>;
  /** Default BATCH_MAX_FRAMES. */
  maxFrames?: number;
  /** Default BATCH_MAX_DELAY_MS. */
  maxDelayMs?: number;
  /** Default APPEND_ATTEMPTS. */
  attempts?: number;
  /** Default APPEND_BACKOFF_BASE_MS. */
  backoffBaseMs?: number;
  /** Runs `fn` after `ms`; default an unref'd setTimeout. */
  setTimer?: (fn: () => void, ms: number) => WriterTimer;
  /** Waits between retries; default a timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Jitter source; default Math.random. */
  random?: () => number;
  logger?: Logger;
  metrics?: Metrics;
}

interface Pending {
  frames: StoredFrame[];
  waiters: { resolve: () => void; reject: (err: unknown) => void }[];
  timer: WriterTimer;
}

const defaultTimer = (fn: () => void, ms: number): WriterTimer => {
  const handle = setTimeout(fn, ms);
  handle.unref();
  return { cancel: () => clearTimeout(handle) };
};

/** Batches sequenced frames into the durable log. */
export class HistoryWriter {
  readonly #deps: HistoryWriterDeps;
  readonly #pending = new Map<string, Pending>();
  readonly #inFlight = new Set<Promise<void>>();
  readonly #metrics: Metrics;

  constructor(deps: HistoryWriterDeps) {
    this.#deps = deps;
    this.#metrics = deps.metrics ?? noopMetrics;
  }

  /** Adds a sequenced frame of session `sid`; resolves once it is durable (see the module comment). */
  add(sid: string, frame: SequencedFrame): Promise<'stored' | 'skipped'> {
    const converted = toStoredFrame(frame);
    if (!converted.ok) {
      if (converted.reason === 'ephemeral') return Promise.resolve('skipped');
      this.#metrics.counter('history_frames_refused_total', { reason: converted.reason }).inc();
      this.#deps.logger?.warn(
        { sid, kind: typeof frame.k === 'string' ? frame.k : 'none', reason: converted.reason },
        'history.frame_refused',
      );
      return Promise.reject(new HistoryFrameRefused(converted.reason));
    }
    return new Promise<'stored' | 'skipped'>((resolve, reject) => {
      let batch = this.#pending.get(sid);
      if (batch === undefined) {
        const timer = (this.#deps.setTimer ?? defaultTimer)(
          () => this.#flush(sid),
          this.#deps.maxDelayMs ?? BATCH_MAX_DELAY_MS,
        );
        batch = { frames: [], waiters: [], timer };
        this.#pending.set(sid, batch);
      }
      batch.frames.push(converted.frame);
      batch.waiters.push({ resolve: () => resolve('stored'), reject });
      if (batch.frames.length >= (this.#deps.maxFrames ?? BATCH_MAX_FRAMES)) this.#flush(sid);
    });
  }

  /** Writes every pending batch now and waits for all writes (shutdown). */
  async flushAll(): Promise<void> {
    for (const sid of [...this.#pending.keys()]) this.#flush(sid);
    await Promise.allSettled([...this.#inFlight]);
  }

  /** Batches not yet written. */
  get pendingSessions(): number {
    return this.#pending.size;
  }

  #flush(sid: string): void {
    const batch = this.#pending.get(sid);
    if (batch === undefined) return;
    this.#pending.delete(sid);
    batch.timer.cancel();
    const write = this.#write(sid, batch).finally(() => this.#inFlight.delete(write));
    this.#inFlight.add(write);
  }

  async #write(sid: string, batch: Pending): Promise<void> {
    const attempts = this.#deps.attempts ?? APPEND_ATTEMPTS;
    const base = this.#deps.backoffBaseMs ?? APPEND_BACKOFF_BASE_MS;
    const sleep = this.#deps.sleep ?? ((ms: number) => sleepFor(ms).then(() => undefined));
    const random = this.#deps.random ?? Math.random;
    for (let attempt = 1; ; attempt++) {
      try {
        await this.#deps.store.append(sid, batch.frames);
        this.#metrics.counter('history_frames_stored_total').inc(batch.frames.length);
        for (const w of batch.waiters) w.resolve();
        return;
      } catch (err) {
        if (attempt >= attempts) {
          this.#metrics.counter('history_append_failures_total').inc();
          this.#deps.logger?.error(
            {
              sid,
              frames: batch.frames.length,
              error: err instanceof Error ? err.name : 'unknown',
            },
            'history.append_failed',
          );
          for (const w of batch.waiters) w.reject(err);
          return;
        }
        const ceiling = base * 2 ** (attempt - 1);
        await sleep(Math.round(ceiling / 2 + (random() * ceiling) / 2));
      }
    }
  }
}
