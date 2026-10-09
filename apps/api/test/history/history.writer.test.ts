/**
 * The history writer (B055, acceptance 7 and failure modes):
 *
 * - a batch is written 2 s after its first frame, or as soon as it holds 500 frames, whichever
 *   comes first; each session has its own batch;
 * - `add` resolves only once the batch is stored (the relay's durability ack); presence and sys
 *   frames resolve `skipped` at once and are never written;
 * - a failed write is retried up to 5 times with growing, jittered waits; after the last one every
 *   waiting `add` rejects and `history_append_failures_total` counts it;
 * - `flushAll` writes what is pending (shutdown).
 */
import { describe, expect, it } from 'vitest';
import {
  BATCH_MAX_DELAY_MS,
  BATCH_MAX_FRAMES,
  HistoryWriter,
  type StoredFrame,
  type WriterTimer,
} from '../../src/modules/history/index.js';
import { recordingMetrics } from '../helpers.js';
import { newId, sequenced } from './helpers.js';

/** Timers the test fires. */
function timers() {
  const pending: { fn: () => void; ms: number; live: boolean }[] = [];
  const setTimer = (fn: () => void, ms: number): WriterTimer => {
    const t = { fn, ms, live: true };
    pending.push(t);
    return { cancel: () => void (t.live = false) };
  };
  const fire = (): void => {
    for (const t of pending.splice(0)) if (t.live) t.fn();
  };
  return { setTimer, fire, pending };
}

function recordingStore() {
  const batches: { sid: string; seqs: number[] }[] = [];
  const state = { failures: 0 };
  return {
    batches,
    state,
    append(sid: string, frames: readonly StoredFrame[]) {
      if (state.failures > 0) {
        state.failures -= 1;
        return Promise.reject(new Error('store down'));
      }
      batches.push({ sid, seqs: frames.map((f) => f.seq) });
      return Promise.resolve({ lastSeq: frames.at(-1)?.seq ?? 0 });
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('HistoryWriter', () => {
  it('writes a batch 2 s after its first frame, and resolves only then', async () => {
    const t = timers();
    const store = recordingStore();
    const writer = new HistoryWriter({ store, setTimer: t.setTimer });
    const sid = newId('ses');
    let done = false;
    const first = writer.add(sid, sequenced(sid, 1)).then((r) => {
      done = true;
      return r;
    });
    void writer.add(sid, sequenced(sid, 2));
    await settle();
    expect(done).toBe(false);
    expect(t.pending.map((p) => p.ms)).toEqual([BATCH_MAX_DELAY_MS]);
    t.fire();
    expect(await first).toBe('stored');
    expect(store.batches).toEqual([{ sid, seqs: [1, 2] }]);
    expect(BATCH_MAX_DELAY_MS).toBe(2_000);
  });

  it('writes at once at 500 frames, per session', async () => {
    const t = timers();
    const store = recordingStore();
    const writer = new HistoryWriter({ store, setTimer: t.setTimer });
    const a = newId('ses');
    const b = newId('ses');
    void writer.add(b, sequenced(b, 1));
    const adds = Array.from({ length: BATCH_MAX_FRAMES }, (_, i) =>
      writer.add(a, sequenced(a, i + 1)),
    );
    await Promise.all(adds);
    expect(store.batches).toHaveLength(1);
    expect(store.batches[0]?.seqs).toHaveLength(500);
    expect(writer.pendingSessions).toBe(1);
    await writer.flushAll();
    expect(store.batches.map((x) => x.sid)).toEqual([a, b]);
    expect(writer.pendingSessions).toBe(0);
  });

  it('skips presence and sys frames at once', async () => {
    const store = recordingStore();
    const writer = new HistoryWriter({ store });
    const sid = newId('ses');
    expect(await writer.add(sid, { ...sequenced(sid, 1), t: 'presence' })).toBe('skipped');
    expect(await writer.add(sid, { t: 'sys.ping' })).toBe('skipped');
    expect(writer.pendingSessions).toBe(0);
  });

  it('retries with growing jittered waits, then rejects and counts the failure', async () => {
    const t = timers();
    const store = recordingStore();
    const waits: number[] = [];
    const recorded = recordingMetrics();
    const writer = new HistoryWriter({
      store,
      setTimer: t.setTimer,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
      random: () => 1,
      metrics: recorded.metrics,
    });
    const sid = newId('ses');
    store.state.failures = 2;
    const ok = writer.add(sid, sequenced(sid, 1));
    t.fire();
    expect(await ok).toBe('stored');
    expect(waits).toEqual([200, 400]);

    store.state.failures = 5;
    const lost = writer.add(sid, sequenced(sid, 2));
    t.fire();
    await expect(lost).rejects.toThrow('store down');
    expect(waits.slice(2)).toEqual([200, 400, 800, 1600]);
    expect(recorded.count('history_append_failures_total')).toBe(1);
  });
});
