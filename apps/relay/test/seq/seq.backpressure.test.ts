/**
 * Bounds on the work a connection can leave waiting (B041, GUIDELINES §3.7): at most
 * `maxQueued` (RELAY_SEQ_BURST) sequenced frames of a connection wait for the store and the rest
 * are refused at once with a 503; a legitimate burst is never refused; for a second after the
 * store fails, frames are refused without calling it; frames still waiting when their connection
 * closes are dropped; and the outage is logged once, not per frame.
 */
import { newId } from '@centcom/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemorySeqStore } from '../../src/seq/memory-store.js';
import { SEQ_DETAILS, SEQ_METRICS, UNAVAILABLE_PAUSE_MS } from '../../src/seq/stage.js';
import { SEQUENCED_STATE_KEY, type SeqStore } from '../../src/seq/types.js';
import type { FakeConnection } from '../connection/helpers.js';
import { captureLogger } from '../helpers.js';
import {
  clientFrame,
  flush,
  heldStore,
  LIMITS,
  reaction,
  seqRelay,
  sentOf,
  unitSequencer,
  type SeqRelay,
  type UnitSequencer,
} from './helpers.js';

/** Starts `frame` through the stage without waiting for it. */
function start(
  unit: UnitSequencer,
  fake: FakeConnection,
  frame: Record<string, unknown>,
): Promise<boolean> {
  let passed = false;
  const fc = { connection: fake.connection, raw: '', frame, state: {} as Record<string, unknown> };
  return unit.sequencer
    .stage(fc, () => {
      passed = fc.state[SEQUENCED_STATE_KEY] !== undefined;
      return Promise.resolve();
    })
    .then(() => passed);
}

describe('frames waiting for the store', () => {
  it('lets at most maxQueued frames of a connection wait; the rest get a 503 at once', async () => {
    const memory = createMemorySeqStore(LIMITS);
    const store = heldStore(memory);
    const unit = unitSequencer({ store, rate: 10_000, burst: 1_000, maxQueued: 50 });
    const sid = newId('ses');
    const member = unit.join(sid);
    const runs = Array.from({ length: 60 }, () => start(unit, member, clientFrame(sid)));
    await flush();
    expect(unit.sequencer.stats().queued).toBe(50);
    expect(store.calls.assign).toBe(1);
    const refused = sentOf(member, 'sys.error');
    expect(refused).toHaveLength(10);
    expect(refused[0]).toMatchObject({
      p: {
        code: 'service_unavailable',
        status: 503,
        retry_after_s: 1,
        detail: SEQ_DETAILS.backlog,
      },
    });
    expect(unit.recorded.count(SEQ_METRICS.sequenced, { outcome: 'backlog' })).toBe(10);
    for (let i = 0; i < 50; i += 1) {
      await store.release();
      await flush();
    }
    expect((await Promise.all(runs)).filter(Boolean)).toHaveLength(50);
    expect(unit.sequencer.stats().queued).toBe(0);
    expect(await memory.head(sid)).toBe(50);
  });

  it('never refuses a burst the rate limit allows (the default bound is the burst)', async () => {
    const store = heldStore(createMemorySeqStore(LIMITS));
    const unit = unitSequencer({ store });
    const sid = newId('ses');
    const member = unit.join(sid);
    const runs = Array.from({ length: 100 }, () => start(unit, member, clientFrame(sid)));
    await flush();
    expect(sentOf(member, 'sys.error')).toEqual([]);
    for (let i = 0; i < 100; i += 1) {
      await store.release();
      await flush();
    }
    expect((await Promise.all(runs)).every(Boolean)).toBe(true);
  });

  it('drops the frames still waiting when their connection closes, without calling the store', async () => {
    const store = heldStore(createMemorySeqStore(LIMITS));
    const unit = unitSequencer({ store });
    const sid = newId('ses');
    const member = unit.join(sid);
    const runs = Array.from({ length: 5 }, () => start(unit, member, clientFrame(sid)));
    await flush();
    member.closeSocket();
    await store.release();
    expect(await Promise.all(runs)).toEqual([true, false, false, false, false]);
    expect(store.calls.assign).toBe(1);
    expect(unit.sequencer.stats()).toMatchObject({ queued: 0, connections: 0, buckets: 0 });
  });
});

describe('after the store fails', () => {
  /** A store that fails while `down` is true. */
  function flakyStore(): SeqStore & { down: boolean; assigns: number } {
    const memory = createMemorySeqStore(LIMITS);
    const store = {
      down: true,
      assigns: 0,
      assign: (...args: Parameters<SeqStore['assign']>) => {
        store.assigns += 1;
        return store.down ? Promise.reject(new Error('redis down')) : memory.assign(...args);
      },
      head: (sid: string) => memory.head(sid),
      range: (sid: string, after: number, limit: number) => memory.range(sid, after, limit),
      oldest: (sid: string) => memory.oldest(sid),
      hydrate: (...args: Parameters<SeqStore['hydrate']>) => memory.hydrate(...args),
      assignBatch: (...args: Parameters<SeqStore['assignBatch']>) => memory.assignBatch(...args),
    };
    return store;
  }

  it('refuses sequenced frames for a second without calling it, then tries again', async () => {
    const store = flakyStore();
    const log = captureLogger();
    const unit = unitSequencer({ store, logger: log.logger });
    const sid = newId('ses');
    const member = unit.join(sid);
    // B060: the failed assign may have written the frame, so its outcome is marked unknown.
    expect((await unit.inbound(member, clientFrame(sid))).unknown).toBe(true);
    expect(store.assigns).toBe(1);
    for (let i = 0; i < 5; i += 1) {
      unit.clock.advance(100);
      const frame = clientFrame(sid);
      const refused = await unit.inbound(member, frame);
      expect(refused.passed).toBe(false);
      // Refused without asking the store: known not stored.
      expect(refused.unknown).toBe(false);
      expect(sentOf(member, 'sys.error').at(-1)).toMatchObject({
        ref: frame['id'],
        p: { code: 'service_unavailable', detail: SEQ_DETAILS.unavailable },
      });
    }
    expect(store.assigns).toBe(1);
    expect(unit.recorded.count(SEQ_METRICS.sequenced, { outcome: 'unavailable' })).toBe(6);
    // One sys.slow_down per second, not one per refusal.
    expect(sentOf(member, 'sys.slow_down')).toHaveLength(1);

    unit.clock.advance(UNAVAILABLE_PAUSE_MS);
    store.down = false;
    const { passed, stored } = await unit.inbound(member, clientFrame(sid));
    expect(passed).toBe(true);
    expect(stored?.seq).toBe(1);
    expect(store.assigns).toBe(2);
    const messages = log.lines().map((l) => l['msg']);
    expect(messages.filter((m) => m === 'relay.seq_unavailable')).toHaveLength(1);
    expect(messages.filter((m) => m === 'relay.seq_available')).toHaveLength(1);
  });

  it('refuses frames already waiting when the store fails, without calling it again', async () => {
    const store = heldStore(createMemorySeqStore(LIMITS));
    const unit = unitSequencer({ store });
    const sid = newId('ses');
    const member = unit.join(sid);
    const runs = Array.from({ length: 4 }, () => start(unit, member, clientFrame(sid)));
    await flush();
    await store.release(new Error('timeout'));
    expect(await Promise.all(runs)).toEqual([false, false, false, false]);
    expect(store.calls.assign).toBe(1);
    expect(sentOf(member, 'sys.error')).toHaveLength(4);
  });
});

describe('a burst on a running relay', () => {
  let live: SeqRelay | undefined;
  afterEach(async () => {
    await live?.stop();
    live = undefined;
  });

  it('sequences 100 frames a client sends at once (the default limits)', async () => {
    const relay = await seqRelay();
    live = relay;
    const client = await relay.client();
    const results = await Promise.all(
      Array.from({ length: 100 }, () => client.send('reaction', reaction())),
    );
    expect(results.map((r) => r.seq).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 100 }, (_, i) => i + 1),
    );
    expect(client.wire.filter((f) => f.t === 'sys.error')).toEqual([]);
  });
});
