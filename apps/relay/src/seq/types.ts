/**
 * Sequencing types (B041, CT-WS-ENVELOPE "Sequencing and delivery guarantees"): the frame as the
 * hot buffer keeps it, the store that assigns `seq`, the durable-append port, the ack tracker and
 * the service the module puts on the relay context (`ctx.seq`) for the lanes after it (B042 resume,
 * B044 fan-out).
 *
 * Owns: these interfaces. Must not: describe anything the relay could read inside `ct`.
 */
import type { Envelope } from '@centcom/contracts';

/** The frame types the relay sequences; `presence`, `ack` and `sys.*` never are. */
export type SequencedType = 'event' | 'queue' | 'control';

/** `t` values that get a `seq`. */
export const SEQUENCED_TYPES: ReadonlySet<string> = new Set<SequencedType>([
  'event',
  'queue',
  'control',
]);

/**
 * A sequenced frame as it is buffered, echoed, fanned out and replayed: the sender's frame with
 * its `p`, `ct`, `sig`, `ref` and `k` untouched, its `ack` consumed by the relay (an ack is about
 * the sender's own inbound stream; CT-CRYPTO does not sign it), and the server's `from`, `ts` and
 * `seq`. Fields are kept in envelope order, so one frame always serialises to the same bytes.
 */
export type StoredFrame = Omit<
  Envelope,
  't' | 'id' | 'sid' | 'from' | 'ts' | 'seq' | 'ack' | 'k'
> & {
  t: SequencedType;
  id: string;
  sid: string;
  /** `mem_…` of the sender, stamped from the connection; `srv` for server frames (B044). */
  from: string;
  /** Server receive time (ISO 8601). */
  ts: string;
  seq: number;
  k: string;
};

/** A frame waiting for its `seq`. */
export type UnsequencedFrame = Omit<StoredFrame, 'seq'>;

/** What `SeqStore.assign` decided. */
export interface AssignResult {
  /** The frame's `seq`: new, or the original one for a duplicate. */
  seq: number;
  /** True when `(sid, from, id)` was already sequenced in the last 24 h. */
  duplicate: boolean;
  /** The `ts` the frame was sequenced with (a duplicate's original one). */
  ts: string;
}

/** Buffer retention (RELAY_BUF_MIN_FRAMES, RELAY_BUF_MIN_AGE_S, RELAY_BUF_MAX_FRAMES). */
export interface BufferLimits {
  /** Frames always kept (5 000). */
  minFrames: number;
  /** Frames younger than this are kept too, up to `maxFrames` (600 000 ms). */
  minAgeMs: number;
  /** Hard cap (20 000). */
  maxFrames: number;
}

/**
 * Where `seq` is assigned and the hot buffer kept. `assign` is atomic: the dedupe check, the next
 * `seq`, the append and the dedupe record happen together or not at all.
 */
export interface SeqStore {
  /**
   * Sequences `frame` from `key.from` in session `sid` at `nowMs`, appends it to the hot buffer and
   * remembers `(sid, from, id)` for 24 h; a key seen before returns its original `seq`, appends
   * nothing and keeps the buffer as it is. Rejects with a 503 AppError when the store is down.
   */
  assign(
    sid: string,
    key: { from: string; id: string },
    frame: UnsequencedFrame,
    nowMs: number,
  ): Promise<AssignResult>;
  /** The newest `seq` of the session; 0 before the first frame. */
  head(sid: string): Promise<number>;
  /** Up to `limit` buffered frames after `afterSeq`, in `seq` order. */
  range(sid: string, afterSeq: number, limit: number): Promise<StoredFrame[]>;
  /** The oldest buffered `seq`, or null when the buffer is empty. */
  oldest(sid: string): Promise<number | null>;
}

/** The durable log behind the hot buffer (port; B042 wires B055's store). */
export interface DurableAppend {
  append(sid: string, f: StoredFrame): Promise<void>;
}

/** Each connection's highest acknowledged `seq`. */
export interface AckTracker {
  /** Records `seq` for connection `connId`; `acked_seq` only ever rises. */
  onAck(connId: string, seq: number): void;
  /** The lowest `acked_seq` of the session's connections on this node; 0 when none has acked. */
  lowestAcked(sid: string): number;
}

/** `ctx.seq`: what the sequence module offers the modules registered after it. */
export interface SeqService {
  readonly store: SeqStore;
  readonly acks: AckTracker;
  /** Replaces the DurableAppend port (default: one that keeps nothing). */
  setDurableAppend(port: DurableAppend): void;
}

/** The key `fc.state` carries a frame's StoredFrame under, for the stages after this one. */
export const SEQUENCED_STATE_KEY = 'seq.frame';
