/**
 * Key epochs (B049, CT-CRYPTO §5, CT-WS-CONTROL `control.rotate_key`): the tracker of each session's
 * epoch, the signal that announces a new one, and the check of a frame's `ct.kid`.
 *
 * - **Rotate** (`EpochSignal.rotate(sid, reason, {after?})`): takes the next epoch number (the
 *   store's counter: never the same twice), emits the server's `control.rotate_key {kid, reason}`
 *   through B044 (`from: "srv"`, sequenced, delivered in order) and records it as current with its
 *   `seq`. With `after` (B051's `control.kick`), both frames are sequenced back to back
 *   (`emitServerBatch`): consecutive `seq`s whatever else the session is sending. Reasons are
 *   `member_removed`, `scheduled` and `requested`; any other throws. Rotations of a session on this
 *   node run one at a time. The relay never chooses, holds or sees a key.
 * - **Kid check** of an encrypted sequenced frame from a connection (`check`): a kid not `k<n>` is
 *   invalid; newer than the current epoch is refused (`future`); older is refused (`stale`) only
 *   once that connection has acked the `seq` of the rotation that superseded it, so frames in flight
 *   across a rotation are not lost. A refusal re-reads the store first (another node may have
 *   rotated); otherwise a session's epoch is cached on the node for CACHE_MS.
 * - **Due** (`EpochTracker.due`): an epoch 7 days old or 100 000 frames long is due a `scheduled`
 *   rotation; it is counted once (`relay_epoch_rotation_due_total`). The relay never rotates by
 *   itself: the host decides.
 *
 * Owns: the epoch logic. Must not: pick key material, or refuse an in-flight frame its sender sent
 * before acking the rotation.
 */
import { noopMetrics, type Logger, type Metrics } from '@centcom/core';
import type { FanOut, ServerFrameSpec } from '../fanout/fanout.js';
import type { SeqStore } from '../seq/types.js';
import type { EpochState, EpochStore } from './epoch-store.js';

/** CT-CRYPTO §5: a scheduled rotation every 7 days or 100 000 frames. */
export const SCHEDULE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const SCHEDULE_FRAMES = 100_000;
/** A session's epoch is re-read from the store at least this often. */
export const CACHE_MS = 5_000;
/** `control.rotate_key.p.reason` values. */
export const ROTATE_REASONS = ['member_removed', 'scheduled', 'requested'] as const;
export type RotateReason = (typeof ROTATE_REASONS)[number];

/** The card's tracker. */
export interface EpochTracker {
  current(
    sid: string,
  ): Promise<{ kid: string; epoch: number; startedAt: string; framesSince: number }>;
  advance(sid: string, toKid: string): Promise<void>;
  due(sid: string): Promise<'none' | 'scheduled'>;
}

/** The card's signal (B051 calls it with `after`: the kick, sequenced right before). */
export interface EpochSignal {
  rotate(
    sid: string,
    reason: RotateReason,
    opts?: { after?: ServerFrameSpec },
  ): Promise<{ seq: number; kid: string }>;
}

/** What `check` decided about a frame's kid. */
export type KidCheck = 'ok' | 'invalid' | 'stale' | 'future';

/** What the epochs need. */
export interface EpochsDeps {
  store: EpochStore;
  seq: Pick<SeqStore, 'head'>;
  /** B044, looked up when a rotation is emitted (its module registers later). */
  fanout: () => Pick<FanOut, 'emitServerBatch'> | undefined;
  clock?: () => number;
  logger?: Logger;
  metrics?: Metrics;
}

const KID = /^k([1-9]\d{0,8})$/;

/** The epoch number of a kid, or null. */
export const epochOf = (kid: unknown): number | null => {
  if (typeof kid !== 'string') return null;
  const m = KID.exec(kid);
  return m === null ? null : Number(m[1]);
};

/** `ctx.epoch`: the tracker, the signal and the kid check. */
export function createEpochs(deps: EpochsDeps): EpochTracker &
  EpochSignal & {
    /** The kid check of an encrypted frame from a connection that acked up to `ackedSeq`. */
    check(sid: string, kid: unknown, ackedSeq: number): Promise<KidCheck>;
    /** The session's epoch (cached up to CACHE_MS). */
    state(sid: string, fresh?: boolean): Promise<EpochState>;
  } {
  const clock = deps.clock ?? Date.now;
  const metrics = deps.metrics ?? noopMetrics;
  const cache = new Map<string, { state: EpochState; at: number }>();
  const chains = new Map<string, Promise<unknown>>();
  /** `sid:epoch` already reported due. */
  const reported = new Set<string>();

  async function state(sid: string, fresh = false): Promise<EpochState> {
    const hit = cache.get(sid);
    if (!fresh && hit !== undefined && clock() - hit.at < CACHE_MS) return hit.state;
    const read = await deps.store.read(sid);
    cache.set(sid, { state: read, at: clock() });
    if (cache.size > 10_000) cache.delete(cache.keys().next().value as string);
    return read;
  }

  /** Runs `task` after the session's earlier rotations on this node. */
  function serial<T>(sid: string, task: () => Promise<T>): Promise<T> {
    const run = (chains.get(sid) ?? Promise.resolve()).then(task, task);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    chains.set(sid, settled);
    void settled.then(() => {
      if (chains.get(sid) === settled) chains.delete(sid);
    });
    return run;
  }

  async function decide(s: EpochState, epoch: number, ackedSeq: number): Promise<KidCheck> {
    if (epoch > s.current) return 'future';
    if (epoch === s.current) return 'ok';
    // Superseded by the rotation into epoch + 1: stale once the sender acked it.
    const superseded = s.rotations.get(epoch + 1);
    return superseded !== undefined && ackedSeq >= superseded ? 'stale' : 'ok';
  }

  return {
    state,
    async check(sid, kid, ackedSeq) {
      const epoch = epochOf(kid);
      if (epoch === null) return 'invalid';
      const verdict = await decide(await state(sid), epoch, ackedSeq);
      if (verdict === 'ok') return 'ok';
      // Another node may have rotated since the cache was filled: read again before refusing.
      return decide(await state(sid, true), epoch, ackedSeq);
    },
    rotate(sid, reason, opts = {}) {
      if (!ROTATE_REASONS.includes(reason)) {
        return Promise.reject(new TypeError(`rotate: ${String(reason)} is not a rotation reason`));
      }
      return serial(sid, async () => {
        const fanout = deps.fanout();
        if (fanout === undefined) throw new Error('rotate: the relay has no fan-out');
        const epoch = await deps.store.next(sid);
        const kid = `k${epoch}`;
        const frames: ServerFrameSpec[] = [
          ...(opts.after === undefined ? [] : [opts.after]),
          { kind: 'control.rotate_key', t: 'control', p: { kid, reason } },
        ];
        const stored = await fanout.emitServerBatch(sid, frames);
        const rotation = stored.at(-1);
        if (rotation === undefined) throw new Error('rotate: nothing was sequenced');
        await deps.store.announce(sid, epoch, rotation.seq, clock());
        cache.delete(sid);
        metrics.counter('relay_epoch_rotations_total', { reason }).inc();
        deps.logger?.info({ sid, epoch, reason }, 'relay.key_epoch_rotated');
        return { seq: rotation.seq, kid };
      });
    },
    async current(sid) {
      const s = await state(sid, true);
      const head = await deps.seq.head(sid);
      return {
        kid: `k${s.current}`,
        epoch: s.current,
        startedAt: new Date(s.startedAt).toISOString(),
        framesSince: Math.max(0, head - s.seq),
      };
    },
    async advance(sid, toKid) {
      const epoch = epochOf(toKid);
      if (epoch === null) throw new TypeError('advance: not a kid');
      await deps.store.announce(sid, epoch, await deps.seq.head(sid), clock());
      cache.delete(sid);
    },
    async due(sid) {
      const s = await state(sid, true);
      const head = await deps.seq.head(sid);
      const old = s.startedAt > 0 && clock() - s.startedAt >= SCHEDULE_AGE_MS;
      const long = head - s.seq >= SCHEDULE_FRAMES;
      if (!old && !long) return 'none';
      const key = `${sid}:${s.current}`;
      if (!reported.has(key)) {
        reported.add(key);
        if (reported.size > 10_000) reported.delete(reported.values().next().value as string);
        metrics.counter('relay_epoch_rotation_due_total').inc();
      }
      return 'scheduled';
    },
  };
}
