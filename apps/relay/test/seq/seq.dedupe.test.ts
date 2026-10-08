/**
 * Dedupe by `(sid, from, id)` for 24 h (B041 acceptance 2 and 3): a resend gets its original
 * `seq` (and `ts`) echoed, nothing is broadcast twice and the buffer holds the frame once, also
 * after a reconnect on a running relay; the record expires at exactly 24 h (fake clock); the same
 * id from another member is another frame.
 */
import { newId } from '@centcom/contracts';
import type { Fault } from '@centcom/testkit/sim';
import { afterEach, describe, expect, it } from 'vitest';
import { DEDUPE_TTL_MS } from '../../src/seq/retention.js';
import { SEQ_METRICS } from '../../src/seq/stage.js';
import type { StoredFrame } from '../../src/seq/types.js';
import type { FakeConnection } from '../connection/helpers.js';
import {
  clientFrame,
  LIMITS,
  reaction,
  seqRelay,
  T0,
  unitSequencer,
  until,
  type SeqRelay,
} from './helpers.js';
import { createMemorySeqStore } from '../../src/seq/memory-store.js';
import { stampFrame } from '../../src/seq/frame.js';

const echoes = (fake: FakeConnection): StoredFrame[] =>
  fake.sent().filter((f) => f['t'] === 'event') as unknown as StoredFrame[];

describe('dedupe (unit)', () => {
  it('echoes a resend with its original seq and ts, broadcasts nothing and buffers it once', async () => {
    const appended: number[] = [];
    const unit = unitSequencer({
      durable: {
        append: (_sid, f) => {
          appended.push(f.seq);
          return Promise.resolve();
        },
      },
    });
    const sid = newId('ses');
    const member = unit.join(sid);
    const frame = clientFrame(sid);
    const first = await unit.inbound(member, frame);
    await unit.inbound(member, clientFrame(sid));
    unit.clock.advance(5_000);
    const again = await unit.inbound(member, { ...frame });

    expect(first.passed).toBe(true);
    expect(again.passed).toBe(false);
    expect(again.stored).toBeUndefined();
    const [original, , resent] = echoes(member);
    expect(resent).toEqual(original);
    expect(resent?.seq).toBe(1);
    expect(resent?.ts).toBe(new Date(T0).toISOString());
    expect((await unit.store.range(sid, 0, 10)).map((f) => f.id)).toEqual([
      frame['id'],
      expect.any(String),
    ]);
    expect(await unit.store.head(sid)).toBe(2);
    expect(appended).toEqual([1, 2]);
    expect(unit.recorded.count(SEQ_METRICS.sequenced, { outcome: 'duplicate' })).toBe(1);
  });

  it('treats the same id from another member as another frame', async () => {
    const unit = unitSequencer();
    const sid = newId('ses');
    const [a, b] = [unit.join(sid), unit.join(sid)] as const;
    const id = newId('msg');
    expect((await unit.inbound(a, clientFrame(sid, { id }))).stored?.seq).toBe(1);
    expect((await unit.inbound(b, clientFrame(sid, { id }))).stored?.seq).toBe(2);
    expect((await unit.inbound(a, clientFrame(sid, { id }))).passed).toBe(false);
    expect((await unit.inbound(b, clientFrame(sid, { id }))).passed).toBe(false);
    expect(await unit.store.head(sid)).toBe(2);
  });

  it('keys on the server-stamped member, so two devices of one member share the record', async () => {
    const unit = unitSequencer();
    const sid = newId('ses');
    const member = newId('mem');
    const laptop = unit.join(sid, member);
    const phone = unit.join(sid, member);
    const frame = clientFrame(sid);
    const [x, y] = await Promise.all([
      unit.inbound(laptop, { ...frame }),
      unit.inbound(phone, { ...frame }),
    ]);
    expect([x.passed, y.passed].filter(Boolean)).toHaveLength(1);
    expect(echoes(laptop)[0]?.seq).toBe(1);
    expect(echoes(phone)[0]?.seq).toBe(1);
    expect(await unit.store.head(sid)).toBe(1);
  });

  it('forgets a frame exactly 24 h after it was sequenced (fake clock)', async () => {
    const store = createMemorySeqStore(LIMITS);
    const sid = newId('ses');
    const from = newId('mem');
    const id = newId('msg');
    const frame = stampFrame(
      { t: 'event', id, k: 'reaction', p: reaction() },
      from,
      new Date(T0).toISOString(),
      sid,
    );
    expect(await store.assign(sid, { from, id }, frame, T0)).toMatchObject({
      seq: 1,
      duplicate: false,
    });
    expect(await store.assign(sid, { from, id }, frame, T0 + DEDUPE_TTL_MS - 1)).toEqual({
      seq: 1,
      duplicate: true,
      ts: new Date(T0).toISOString(),
    });
    expect(await store.assign(sid, { from, id }, frame, T0 + DEDUPE_TTL_MS)).toMatchObject({
      seq: 2,
      duplicate: false,
    });
    // The new record runs from the second assignment.
    expect(await store.assign(sid, { from, id }, frame, T0 + 2 * DEDUPE_TTL_MS - 1)).toMatchObject({
      seq: 2,
      duplicate: true,
    });
  });

  it('sweeps expired records, so 24 h of traffic is all it keeps', async () => {
    const unit = unitSequencer({ rate: 10_000, burst: 10_000 });
    const sid = newId('ses');
    const member = unit.join(sid);
    for (let i = 0; i < 50; i += 1) await unit.inbound(member, clientFrame(sid));
    expect(unit.memory.dedupeRecords()).toBe(50);
    unit.clock.advance(DEDUPE_TTL_MS);
    await unit.inbound(member, clientFrame(sid));
    expect(unit.memory.dedupeRecords()).toBe(1);
  });

  it('resends through the stage at the 24 h boundary: a duplicate before it, a new frame at it', async () => {
    const unit = unitSequencer();
    const sid = newId('ses');
    const member = unit.join(sid);
    const frame = clientFrame(sid);
    await unit.inbound(member, frame);
    unit.clock.advance(DEDUPE_TTL_MS - 1);
    expect((await unit.inbound(member, { ...frame })).passed).toBe(false);
    unit.clock.advance(1);
    const fresh = await unit.inbound(member, { ...frame });
    expect(fresh.passed).toBe(true);
    expect(fresh.stored?.seq).toBe(2);
  });
});

/** Drops the first sequenced frame carrying `id` this client receives (a lost echo). */
function loseEchoOnce(id: string): Fault {
  let lost = false;
  return (data, next) => {
    if (!lost && data.includes(`"id":"${id}"`) && data.includes('"seq":')) {
      lost = true;
      return;
    }
    next(data);
  };
}

describe('dedupe on a running relay', () => {
  let live: SeqRelay | undefined;
  afterEach(async () => {
    await live?.stop();
    live = undefined;
  });

  it('a client that resends after a reconnect gets the original seq echoed; nothing is broadcast twice; the buffer holds it once', async () => {
    const relay = await seqRelay();
    live = relay;
    const id = newId('msg');
    const sender = await relay.client({ faults: [loseEchoOnce(id)] });
    const watcher = await relay.client();
    const frame = {
      v: 1 as const,
      t: 'event' as const,
      id,
      sid: relay.sid,
      k: 'reaction',
      p: reaction(),
    };
    const sent = sender.sendFrame(frame);
    await until(() => watcher.wire.some((f) => f.id === id));
    // The echo was lost: the frame is still unacked, so the reconnect resends it with its id.
    expect(sender.unackedIds).toEqual([id]);
    await sender.reconnect({ ticket: await relay.ticket(sender.claims) });
    expect((await sent).seq).toBe(1);

    const echoed = sender.wire.filter((f) => f.id === id);
    expect(echoed.map((f) => f.seq)).toEqual([1]);
    // Another frame after the resend proves the watcher had every chance to see a second copy.
    await sender.send('reaction', reaction());
    await until(() => watcher.wire.some((f) => f.seq === 2));
    expect(watcher.wire.filter((f) => f.id === id)).toHaveLength(1);
    expect(relay.store.size(relay.sid)).toBe(2);
    expect((await relay.store.range(relay.sid, 0, 10)).map((f) => f.id)[0]).toBe(id);
    expect(relay.relay.recorded.count(SEQ_METRICS.sequenced, { outcome: 'duplicate' })).toBe(1);
  });
});
