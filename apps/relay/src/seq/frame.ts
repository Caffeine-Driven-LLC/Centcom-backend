/**
 * Stamping and serialising sequenced frames (B041): the server's `from` and `ts` go on a decoded
 * client frame, `seq` after the store assigned it, always in envelope field order (v, t, id, sid,
 * from, ts, seq, ref, k, p, ct, sig). The stores keep a frame as the exact JSON the relay sends,
 * built by splicing the `seq` between two halves (`seqParts`), so the echo, the fan-out and a later
 * replay are byte-identical.
 *
 * Owns: the field order and the splice. Must not: read, copy into new shapes or re-encode `p`,
 * `ct` or `sig` (they are carried as the decoder left them).
 */
import type { StoredFrame, UnsequencedFrame, SequencedType } from './types.js';

/** The decoded client frame fields this module reads. */
export interface SequencableFrame {
  t: SequencedType;
  id: string;
  k: string;
  ref?: string;
  p?: Record<string, unknown>;
  ct?: StoredFrame['ct'];
  sig?: string;
}

/** The fields after `seq`, as an object in envelope order (only those present). */
function tail(frame: SequencableFrame | UnsequencedFrame): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (frame.ref !== undefined) out['ref'] = frame.ref;
  out['k'] = frame.k;
  if (frame.p !== undefined) out['p'] = frame.p;
  if (frame.ct !== undefined) out['ct'] = frame.ct;
  if (frame.sig !== undefined) out['sig'] = frame.sig;
  return out;
}

/**
 * `frame` from member `from` of session `sid`, received at `ts`: the client's `ack` is dropped and
 * any client `from`, `ts` or `seq` (the decoder already strips them) is never read.
 */
export function stampFrame(
  frame: SequencableFrame,
  from: string,
  ts: string,
  sid: string,
): UnsequencedFrame {
  return {
    v: 1,
    t: frame.t,
    id: frame.id,
    sid,
    from,
    ts,
    ...tail(frame),
  } as UnsequencedFrame;
}

/** `frame` with `seq`, in envelope order. */
export function withSeq(frame: UnsequencedFrame, seq: number): StoredFrame {
  return {
    v: frame.v,
    t: frame.t,
    id: frame.id,
    sid: frame.sid,
    from: frame.from,
    ts: frame.ts,
    seq,
    ...tail(frame),
  } as StoredFrame;
}

/**
 * The JSON of `frame` cut where its `seq` goes: `prefix + seq + suffix` equals
 * `JSON.stringify(withSeq(frame, seq))` for every `seq`.
 */
export function seqParts(frame: UnsequencedFrame): { prefix: string; suffix: string } {
  const head = JSON.stringify({
    v: frame.v,
    t: frame.t,
    id: frame.id,
    sid: frame.sid,
    from: frame.from,
    ts: frame.ts,
  });
  const rest = JSON.stringify(tail(frame));
  return {
    prefix: `${head.slice(0, -1)},"seq":`,
    suffix: rest === '{}' ? '}' : `,${rest.slice(1)}`,
  };
}

/** A frame a store kept (its own JSON; never client input). */
export const parseStoredFrame = (json: string): StoredFrame => JSON.parse(json) as StoredFrame;
