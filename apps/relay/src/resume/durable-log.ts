/**
 * The durable log as the relay uses it (B042 over B055's history store, `@centcom/storage`):
 *
 * - `historyDurableAppend(writer)`: B041's `DurableAppend` port. Each sequenced frame goes to the
 *   `HistoryWriter`, which batches it into the log and resolves once it is stored. A frame the log
 *   refuses to keep (an encrypted kind carrying `p`; counted and logged by the writer) resolves
 *   too: retrying it could never succeed.
 * - `historyLogReader(store)`: the `DurableLogReader` the replay and hydration read. Frames come
 *   back in the relay's own shape and field order (`relayFrameOf`), so a frame replayed from the log
 *   is the same JSON the hot buffer and fan-out sent: the log keeps `id`, `from`, `ts`, `seq`,
 *   `ref`, `k`, `ct` and `sig` as they were, and the `p` CT-RESUME lets it keep (the catalogue's
 *   clear fields, which is all a conforming frame carries).
 *
 * Owns: the adapters. Must not: decode or reformat `ct`, or read across sessions.
 */
import {
  HistoryFrameRefused,
  type HistoryStore,
  type HistoryWriter,
  type StoredFrame as HistoryFrame,
} from '@centcom/storage';
import { withSeq } from '../seq/frame.js';
import type { DurableAppend, StoredFrame, UnsequencedFrame } from '../seq/types.js';
import type { DurableLogReader } from './types.js';

/** The relay's frame of session `sid` for a frame of the log, in envelope order. */
export function relayFrameOf(sid: string, f: HistoryFrame): StoredFrame {
  const unsequenced = {
    v: 1,
    t: f.kindClass,
    id: f.id,
    sid,
    from: f.from,
    ts: f.ts,
    ...(f.ref === undefined ? {} : { ref: f.ref }),
    k: f.k,
    ...(f.p === null ? {} : { p: f.p }),
    ...(f.ct === null ? {} : { ct: f.ct }),
    ...(f.sig === undefined ? {} : { sig: f.sig }),
  } as UnsequencedFrame;
  return withSeq(unsequenced, f.seq);
}

/** B041's DurableAppend port over the history writer. */
export function historyDurableAppend(writer: Pick<HistoryWriter, 'add'>): DurableAppend {
  return {
    append: (sid, frame) =>
      writer.add(sid, frame).then(
        () => undefined,
        (err: unknown) => {
          if (err instanceof HistoryFrameRefused) return undefined;
          throw err;
        },
      ),
  };
}

/** The DurableLogReader over the history store. */
export function historyLogReader(store: Pick<HistoryStore, 'read'>): DurableLogReader {
  return {
    async range(sid, afterSeq, limit) {
      const page = await store.read(sid, afterSeq, limit);
      return page.frames.map((f) => relayFrameOf(sid, f));
    },
    async maxSeq(sid) {
      // A read past every frame returns none, and the log's head.
      const page = await store.read(sid, Number.MAX_SAFE_INTEGER - 1, 1);
      return page.headSeq ?? 0;
    },
  };
}
