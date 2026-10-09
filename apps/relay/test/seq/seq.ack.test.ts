/**
 * Acks (B041 acceptance 7): `acked_seq` per connection only rises; an ack beyond the session's
 * head is `sys.error invalid_frame` (pointer `/ack`) and moves nothing; pure `ack` frames are
 * consumed, piggy-backed ones are read and the frame goes on; acks of frames another node
 * sequenced are checked against the store; repeated invalid acks close 4400 like other invalid
 * frames.
 */
import { newId } from '@centcom/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { CloseCode } from '../../src/close-codes.js';
import { createAckTracker } from '../../src/seq/acks.js';
import { stampFrame } from '../../src/seq/frame.js';
import { createMemorySeqStore } from '../../src/seq/memory-store.js';
import {
  INVALID_ACK_WINDOW_MS,
  INVALID_ACKS_PER_WINDOW,
  SEQ_METRICS,
} from '../../src/seq/stage.js';
import type { SeqStore } from '../../src/seq/types.js';
import type { FakeConnection } from '../connection/helpers.js';
import {
  clientFrame,
  flush,
  heldStore,
  LIMITS,
  reaction,
  seqRelay,
  sentOf,
  unitSequencer,
  until,
  type SeqRelay,
  type UnitSequencer,
} from './helpers.js';

const ack = (sid: string, n: number): Record<string, unknown> => ({ v: 1, t: 'ack', sid, ack: n });

/** A unit stage with `n` frames sequenced by `fake`'s member. */
async function withFrames(
  n: number,
  overrides: Parameters<typeof unitSequencer>[0] = {},
): Promise<{
  unit: UnitSequencer;
  sid: string;
  fake: FakeConnection;
}> {
  const unit = unitSequencer(overrides);
  const sid = newId('ses');
  const fake = unit.join(sid);
  for (let i = 0; i < n; i += 1) await unit.inbound(fake, clientFrame(sid));
  return { unit, sid, fake };
}

describe('acked_seq (unit)', () => {
  it('only rises; a pure ack frame is consumed and answered with nothing', async () => {
    const { unit, sid, fake } = await withFrames(5);
    const acks = unit.sequencer.service.acks;
    const id = fake.connection.entry.id;
    const before = fake.sent().length;
    for (const [n, expected] of [
      [3, 3],
      [2, 3],
      [0, 3],
      [5, 5],
      [4, 5],
    ] as const) {
      const { passed } = await unit.inbound(fake, ack(sid, n));
      expect(passed).toBe(false);
      expect(unit.sequencer.service.acks.lowestAcked(sid)).toBe(expected);
    }
    expect(fake.sent()).toHaveLength(before);
    expect(acks.lowestAcked(sid)).toBe(5);
    expect(id).toBe(fake.connection.entry.id);
  });

  it('refuses an ack beyond the head: sys.error invalid_frame at /ack, acked_seq unchanged', async () => {
    const { unit, sid, fake } = await withFrames(5);
    await unit.inbound(fake, ack(sid, 4));
    const { passed } = await unit.inbound(fake, ack(sid, 6));
    expect(passed).toBe(false);
    expect(unit.sequencer.service.acks.lowestAcked(sid)).toBe(4);
    const [error] = sentOf(fake, 'sys.error');
    expect(error).toMatchObject({
      v: 1,
      t: 'sys.error',
      p: {
        code: 'invalid_frame',
        status: 400,
        errors: [{ pointer: '/ack', code: 'invalid' }],
      },
    });
    expect(error).not.toHaveProperty('ref');
    expect(unit.recorded.count(SEQ_METRICS.acksRejected)).toBe(1);
  });

  it('reads an ack piggy-backed on a sequenced frame, which is then sequenced', async () => {
    const { unit, sid, fake } = await withFrames(3);
    const { passed, stored } = await unit.inbound(fake, clientFrame(sid, { ack: 2 }));
    expect(passed).toBe(true);
    expect(stored?.seq).toBe(4);
    expect(stored).not.toHaveProperty('ack');
    expect(unit.sequencer.service.acks.lowestAcked(sid)).toBe(2);
  });

  it('drops a frame whose piggy-backed ack is beyond the head, with a sys.error naming the frame', async () => {
    const { unit, sid, fake } = await withFrames(3);
    const frame = clientFrame(sid, { ack: 9 });
    const { passed } = await unit.inbound(fake, frame);
    expect(passed).toBe(false);
    expect(await unit.store.head(sid)).toBe(3);
    expect(sentOf(fake, 'sys.error')[0]).toMatchObject({
      ref: frame['id'],
      p: { code: 'invalid_frame', errors: [{ pointer: '/ack' }] },
    });
  });

  it('reads an ack on a presence frame and passes the frame on', async () => {
    const { unit, sid, fake } = await withFrames(2);
    const presence = {
      v: 1,
      t: 'presence',
      sid,
      k: 'presence.update',
      ack: 2,
      p: { state: 'active' },
    };
    const { passed } = await unit.inbound(fake, presence);
    expect(passed).toBe(true);
    expect(unit.sequencer.service.acks.lowestAcked(sid)).toBe(2);
  });

  it('accepts acks of frames sequenced elsewhere (another node) after one store lookup', async () => {
    const memory = createMemorySeqStore(LIMITS);
    let heads = 0;
    const store: SeqStore = {
      assign: (...args) => memory.assign(...args),
      range: (...args) => memory.range(...args),
      oldest: (sid) => memory.oldest(sid),
      hydrate: (...args) => memory.hydrate(...args),
      head: (sid) => {
        heads += 1;
        return memory.head(sid);
      },
    };
    const { unit, sid, fake } = await withFrames(2, { store });
    // Another node sequences 3..10 for the same session.
    for (let i = 0; i < 8; i += 1) {
      const from = newId('mem');
      const id = newId('msg');
      const frame = stampFrame({ t: 'event', id, k: 'reaction', p: reaction() }, from, 'x', sid);
      await memory.assign(sid, { from, id }, frame, 0);
    }
    await Promise.all([
      unit.inbound(fake, ack(sid, 10)),
      unit.inbound(fake, ack(sid, 9)),
      unit.inbound(fake, ack(sid, 8)),
    ]);
    expect(unit.sequencer.service.acks.lowestAcked(sid)).toBe(10);
    expect(heads).toBe(1);
    expect(sentOf(fake, 'sys.error')).toEqual([]);
  });

  it('when the head cannot be read, records nothing and lets the frame go on', async () => {
    const memory = createMemorySeqStore(LIMITS);
    const store: SeqStore = {
      assign: (...args) => memory.assign(...args),
      range: (...args) => memory.range(...args),
      oldest: (sid) => memory.oldest(sid),
      hydrate: (...args) => memory.hydrate(...args),
      head: () => Promise.reject(new Error('down')),
    };
    const { unit, sid, fake } = await withFrames(2, { store });
    const { passed, stored } = await unit.inbound(fake, clientFrame(sid, { ack: 7 }));
    expect(passed).toBe(true);
    expect(stored?.seq).toBe(3);
    expect(unit.sequencer.service.acks.lowestAcked(sid)).toBe(0);
    expect(sentOf(fake, 'sys.error')).toEqual([]);
  });

  it(`closes 4400 on the ${INVALID_ACKS_PER_WINDOW + 1}th invalid ack within 60 s, not before, and forgets old ones`, async () => {
    const { unit, sid, fake } = await withFrames(1);
    for (let i = 0; i < INVALID_ACKS_PER_WINDOW; i += 1) await unit.inbound(fake, ack(sid, 50));
    expect(fake.events.some((e) => e.kind === 'close')).toBe(false);
    unit.clock.advance(INVALID_ACK_WINDOW_MS);
    for (let i = 0; i < INVALID_ACKS_PER_WINDOW; i += 1) await unit.inbound(fake, ack(sid, 50));
    expect(fake.events.some((e) => e.kind === 'close')).toBe(false);
    await unit.inbound(fake, ack(sid, 50));
    const close = fake.events.find((e) => e.kind === 'close');
    expect(close).toMatchObject({ code: CloseCode.ProtocolViolation });
    const last = fake.sent().at(-1);
    expect(last).toMatchObject({ t: 'sys.error', p: { code: 'invalid_frame' } });
    // A closing connection's later frames are dropped unread.
    const after = fake.sent().length;
    await unit.inbound(fake, ack(sid, 50));
    await unit.inbound(fake, clientFrame(sid));
    expect(fake.sent()).toHaveLength(after);
  });

  it('reports the lowest acked_seq of the session’s connections, and forgets closed ones', async () => {
    const unit = unitSequencer();
    const sid = newId('ses');
    const a = unit.join(sid);
    const b = unit.join(sid);
    for (let i = 0; i < 6; i += 1) await unit.inbound(a, clientFrame(sid));
    await unit.inbound(a, ack(sid, 6));
    await unit.inbound(b, ack(sid, 2));
    expect(unit.sequencer.service.acks.lowestAcked(sid)).toBe(2);
    b.closeSocket();
    expect(unit.sequencer.service.acks.lowestAcked(sid)).toBe(6);
    a.closeSocket();
    expect(unit.sequencer.service.acks.lowestAcked(sid)).toBe(0);
    expect(unit.sequencer.stats()).toMatchObject({ connections: 0, sessions: 0, buckets: 0 });
  });
});

describe('acks never queue', () => {
  it('takes an ack within the known head at once, while a sequenced frame waits for the store', async () => {
    const memory = createMemorySeqStore(LIMITS);
    const store = heldStore(memory);
    const { unit, sid, fake } = await withFrames(0, { store });
    for (let i = 0; i < 3; i += 1) {
      const run = unit.inbound(fake, clientFrame(sid));
      await flush();
      await store.release();
      await run;
    }
    const waiting = unit.inbound(fake, clientFrame(sid));
    await flush();
    expect(store.waiting()).toBe(1);
    await unit.inbound(fake, ack(sid, 2));
    expect(unit.sequencer.service.acks.lowestAcked(sid)).toBe(2);
    await store.release();
    await waiting;
  });

  it('lets one ack per connection wait for the head; later ones only raise it', async () => {
    const memory = createMemorySeqStore(LIMITS);
    const store = heldStore(memory);
    const { unit, sid, fake } = await withFrames(0, { store });
    // Another node sequences 60 frames of the session.
    for (let i = 0; i < 60; i += 1) {
      const from = newId('mem');
      const id = newId('msg');
      const frame = stampFrame({ t: 'event', id, k: 'reaction', p: reaction() }, from, 'x', sid);
      await memory.assign(sid, { from, id }, frame, 0);
    }
    const runs = Array.from({ length: 50 }, (_, i) => unit.inbound(fake, ack(sid, 4 + i)));
    await flush();
    expect(store.calls.head).toBe(1);
    expect(store.waiting()).toBe(1);
    await store.release();
    await Promise.all(runs);
    expect(unit.sequencer.service.acks.lowestAcked(sid)).toBe(53);
    expect(sentOf(fake, 'sys.error')).toEqual([]);
  });

  it('refuses once when the highest waiting ack is beyond the head', async () => {
    const store = heldStore(createMemorySeqStore(LIMITS));
    const { unit, sid, fake } = await withFrames(0, { store });
    const runs = Array.from({ length: 20 }, (_, i) => unit.inbound(fake, ack(sid, 1 + i)));
    await flush();
    await store.release();
    await Promise.all(runs);
    expect(sentOf(fake, 'sys.error')).toHaveLength(1);
    expect(unit.sequencer.service.acks.lowestAcked(sid)).toBe(0);
  });

  it('counts a connection that has sent any frame, so lowestAcked sees a silent one as 0', async () => {
    const { unit, sid, fake } = await withFrames(3);
    await unit.inbound(fake, ack(sid, 3));
    const viewer = unit.join(sid);
    const presence = { v: 1, t: 'presence', sid, k: 'presence.update', p: { state: 'active' } };
    await unit.inbound(viewer, presence);
    expect(unit.sequencer.service.acks.lowestAcked(sid)).toBe(0);
  });
});

describe('the ack tracker', () => {
  it('ignores unknown connections and impossible values; forget is idempotent', () => {
    const tracker = createAckTracker();
    tracker.onAck('nobody', 5);
    expect(tracker.acked('nobody')).toBe(0);
    tracker.track('c1', 'ses_a');
    tracker.track('c1', 'ses_a');
    tracker.onAck('c1', -1);
    tracker.onAck('c1', 1.5);
    tracker.onAck('c1', 4);
    expect(tracker.acked('c1')).toBe(4);
    expect(tracker.size).toBe(1);
    tracker.forget('c1');
    tracker.forget('c1');
    expect(tracker.size).toBe(0);
    expect(tracker.lowestAcked('ses_a')).toBe(0);
  });
});

describe('acks on a running relay', () => {
  let live: SeqRelay | undefined;
  afterEach(async () => {
    await live?.stop();
    live = undefined;
  });

  it('records a SimClient’s ack, and answers an ack beyond the head with sys.error', async () => {
    const relay = await seqRelay();
    live = relay;
    const client = await relay.client();
    for (let i = 0; i < 3; i += 1) await client.send('reaction', reaction());
    client.ack();
    await until(() => relay.ctx.seq?.acks.lowestAcked(relay.sid) === 3);
    client.sendRaw(JSON.stringify({ v: 1, t: 'ack', sid: relay.sid, ack: 99 }));
    const error = await client.waitFor((f) => f.t === 'sys.error');
    expect(error.p).toMatchObject({ code: 'invalid_frame', errors: [{ pointer: '/ack' }] });
    expect(relay.ctx.seq?.acks.lowestAcked(relay.sid)).toBe(3);
    expect(client.isOpen).toBe(true);
  });
});
