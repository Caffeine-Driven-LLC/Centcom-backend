/**
 * Assigning `seq` (B041 acceptance 1, 3 and 4): every sequenced frame of a session gets the next
 * `seq`, gapless and exactly once, in each sender's order, whatever the interleaving (a property
 * test over random interleavings of five senders); 1 000 frames from 5 SimClients on a running
 * relay come out as 1..1000 and every client observes them in increasing order; the same `id`
 * from two members is two frames; the echo carries the server's `seq`, `ts` and `from`, whatever
 * the client claimed.
 */
import { newId } from '@centcom/contracts';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { SEQ_METRICS } from '../../src/seq/stage.js';
import { SEQUENCED_STATE_KEY, type StoredFrame } from '../../src/seq/types.js';
import type { FakeConnection } from '../connection/helpers.js';
import {
  clientFrame,
  reaction,
  seqRelay,
  T0,
  unitSequencer,
  until,
  type SeqRelay,
} from './helpers.js';

const sequenced = (fake: FakeConnection): StoredFrame[] =>
  fake.sent().filter((f) => f['t'] === 'event') as unknown as StoredFrame[];

describe('assigning seq (unit, property)', () => {
  it('numbers any interleaving of five senders 1..n, once each, in every sender’s order, and every connection sees them in increasing order', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 4 }), { minLength: 1, maxLength: 150 }),
        fc.array(fc.nat({ max: 3 }), { minLength: 1, maxLength: 150 }),
        async (senders, pauses) => {
          const unit = unitSequencer({ rate: 10_000, burst: 10_000 });
          const sid = newId('ses');
          const conns = Array.from({ length: 5 }, () => unit.join(sid));
          const sentIds: string[][] = conns.map(() => []);
          const runs: Promise<void>[] = [];
          for (const [i, s] of senders.entries()) {
            const fake = conns[s] as FakeConnection;
            const frame = clientFrame(sid);
            (sentIds[s] as string[]).push(frame['id'] as string);
            const fcx = { connection: fake.connection, raw: '', frame, state: {} };
            // Fan-out as B044 will: the frame goes to every other connection of the session.
            runs.push(
              unit.sequencer.stage(fcx, () => {
                const stored = (fcx.state as Record<string, unknown>)[SEQUENCED_STATE_KEY];
                for (const other of conns) {
                  if (other !== fake) other.connection.send(stored as object);
                }
                return Promise.resolve();
              }),
            );
            // Random microtask gaps between arrivals vary the interleaving further.
            for (let p = 0; p < (pauses[i % pauses.length] ?? 0); p += 1) await Promise.resolve();
          }
          await Promise.all(runs);

          const n = senders.length;
          const all = await unit.store.range(sid, 0, 1_000);
          expect(all.map((f) => f.seq)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
          expect(new Set(all.map((f) => f.id)).size).toBe(n);
          for (const [s, fake] of conns.entries()) {
            const seen = sequenced(fake).map((f) => f.seq);
            // Echoes plus broadcasts: the whole session, in increasing order.
            expect(seen).toEqual(Array.from({ length: n }, (_, i) => i + 1));
            // The sender's own frames keep their send order.
            const own = all
              .filter((f) => f.from === fake.connection.entry.memberId)
              .map((f) => f.id);
            expect(own).toEqual(sentIds[s]);
          }
        },
      ),
      { numRuns: 60 },
    );
  });

  it('starts every session at 1 and keeps sessions apart', async () => {
    const unit = unitSequencer();
    const a = unit.join(newId('ses'));
    const b = unit.join(newId('ses'));
    const sidA = a.connection.entry.sessionId as string;
    const sidB = b.connection.entry.sessionId as string;
    await unit.inbound(a, clientFrame(sidA));
    await unit.inbound(a, clientFrame(sidA));
    await unit.inbound(b, clientFrame(sidB));
    expect(sequenced(a).map((f) => f.seq)).toEqual([1, 2]);
    expect(sequenced(b).map((f) => f.seq)).toEqual([1]);
    expect(await unit.store.head(sidA)).toBe(2);
    expect(await unit.store.head(sidB)).toBe(1);
  });

  it('sequences event, queue and control frames in one seq space and passes the stored frame on', async () => {
    const unit = unitSequencer();
    const sid = newId('ses');
    const host = unit.join(sid);
    const kinds = [
      { t: 'event', k: 'message.user' },
      { t: 'queue', k: 'queue.submit' },
      { t: 'control', k: 'control.kick' },
    ];
    for (const [i, { t, k }] of kinds.entries()) {
      const { passed, stored } = await unit.inbound(host, clientFrame(sid, { t, k }));
      expect(passed).toBe(true);
      expect(stored).toMatchObject({ t, k, seq: i + 1, sid });
    }
    expect(unit.recorded.count(SEQ_METRICS.sequenced, { outcome: 'assigned' })).toBe(3);
    expect(unit.recorded.observations(SEQ_METRICS.assignMs)).toHaveLength(3);
  });

  it('leaves presence and sys frames alone: not sequenced, passed on untouched', async () => {
    const unit = unitSequencer();
    const sid = newId('ses');
    const member = unit.join(sid);
    for (const frame of [
      { v: 1, t: 'presence', sid, k: 'presence.update', p: { state: 'active' } },
      { v: 1, t: 'sys.resume', p: { last_seq: 3 } },
    ]) {
      const { passed, stored } = await unit.inbound(member, frame);
      expect(passed).toBe(true);
      expect(stored).toBeUndefined();
    }
    expect(member.sent()).toEqual([]);
    expect(await unit.store.head(sid)).toBe(0);
  });

  it('passes frames on untouched before the handshake has named the session and member', async () => {
    const unit = unitSequencer();
    const sid = newId('ses');
    const fresh = unit.join(sid);
    fresh.connection.entry.memberId = null;
    const { passed, stored } = await unit.inbound(fresh, clientFrame(sid));
    expect(passed).toBe(true);
    expect(stored).toBeUndefined();
    expect(await unit.store.head(sid)).toBe(0);
  });
});

describe('ids and server fields (unit)', () => {
  it('treats the same id from two different members as two frames', async () => {
    const unit = unitSequencer();
    const sid = newId('ses');
    const alice = unit.join(sid);
    const bob = unit.join(sid);
    const id = newId('msg');
    const a = await unit.inbound(alice, clientFrame(sid, { id }));
    const b = await unit.inbound(bob, clientFrame(sid, { id }));
    expect(a.stored?.seq).toBe(1);
    expect(b.stored?.seq).toBe(2);
    expect(a.passed && b.passed).toBe(true);
    const buffered = await unit.store.range(sid, 0, 10);
    expect(buffered.map((f) => [f.id, f.from])).toEqual([
      [id, alice.connection.entry.memberId],
      [id, bob.connection.entry.memberId],
    ]);
  });

  it('echoes the frame with the server’s seq, ts and from, whatever the client claimed, and drops its ack', async () => {
    const unit = unitSequencer();
    const sid = newId('ses');
    const member = unit.join(sid);
    unit.clock.advance(1_234);
    const frame = clientFrame(sid, {
      seq: 999,
      from: newId('mem'),
      ts: '1999-01-01T00:00:00.000Z',
      ref: newId('msg'),
    });
    await unit.inbound(member, frame);
    const [echo] = sequenced(member);
    expect(echo).toEqual({
      v: 1,
      t: 'event',
      id: frame['id'],
      sid,
      from: member.connection.entry.memberId,
      ts: new Date(T0 + 1_234).toISOString(),
      seq: 1,
      ref: frame['ref'],
      k: 'reaction',
      p: frame['p'],
    });
    // Envelope field order, so every copy of the frame serialises to the same bytes.
    expect(Object.keys(echo as object)).toEqual([
      'v',
      't',
      'id',
      'sid',
      'from',
      'ts',
      'seq',
      'ref',
      'k',
      'p',
    ]);
  });

  it('keeps p, ct and sig exactly as the sender sent them', async () => {
    const unit = unitSequencer();
    const sid = newId('ses');
    const member = unit.join(sid);
    const ct = { alg: 'xchacha20poly1305', kid: 'k3', n: 'bm9uY2Vub25jZQ', c: 'Y2lwaGVy-dGV4dA_' };
    const frame = clientFrame(sid, { k: 'message.user', p: undefined, ct, sig: 'c2lnbmF0dXJl' });
    delete frame['p'];
    await unit.inbound(member, frame);
    const [buffered] = await unit.store.range(sid, 0, 1);
    expect(buffered?.ct).toEqual(ct);
    expect(buffered?.sig).toBe('c2lnbmF0dXJl');
    expect(buffered).not.toHaveProperty('p');
    expect(JSON.stringify(sequenced(member)[0])).toBe(JSON.stringify(buffered));
  });
});

describe('assigning seq on a running relay', () => {
  let live: SeqRelay | undefined;
  afterEach(async () => {
    await live?.stop();
    live = undefined;
  });

  it('gives 1 000 frames from 5 concurrent SimClients seq 1..1000, once each, and every client observes them in increasing order', async () => {
    const relay = await seqRelay({ rate: 10_000, burst: 10_000 });
    live = relay;
    const clients = await Promise.all(Array.from({ length: 5 }, () => relay.client()));
    const results = await Promise.all(
      clients.flatMap((client) =>
        Array.from({ length: 200 }, (_, i) => client.send('reaction', { ...reaction(), n: i })),
      ),
    );
    const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 1_000 }, (_, i) => i + 1));

    await until(
      () => clients.every((c) => c.frames.filter((f) => f.t === 'event').length === 1_000),
      10_000,
    );
    const expected = Array.from({ length: 1_000 }, (_, i) => i + 1);
    for (const client of clients) {
      expect(client.frames.filter((f) => f.t === 'event').map((f) => f.seq)).toEqual(expected);
      // On the wire too: the relay itself sends them in order (echoes and fan-out alike).
      expect(client.wire.filter((f) => f.t === 'event').map((f) => f.seq)).toEqual(expected);
    }
    expect(await relay.store.head(relay.sid)).toBe(1_000);
    expect(relay.store.size(relay.sid)).toBe(1_000);
  }, 30_000);

  it('overwrites a client-supplied seq, ts and from; the echo carries the server’s', async () => {
    const relay = await seqRelay();
    live = relay;
    const client = await relay.client();
    const other = await relay.client();
    const before = Date.now();
    const frame = {
      v: 1 as const,
      t: 'event' as const,
      id: newId('msg'),
      sid: relay.sid,
      k: 'reaction',
      p: reaction(),
      seq: 4242,
      ts: '1999-01-01T00:00:00.000Z',
      from: other.claims.mid,
    };
    const result = await client.sendFrame(frame, { allowServerFields: true });
    expect(result.seq).toBe(1);
    const echo = client.frames.find((f) => f.id === frame.id);
    expect(echo?.seq).toBe(1);
    expect(echo?.from).toBe(client.claims.mid);
    expect(Date.parse(echo?.ts ?? '')).toBeGreaterThanOrEqual(before - 1);
    expect(Date.parse(echo?.ts ?? '')).toBeLessThanOrEqual(Date.now() + 1);
  });

  it('advertises the enforced seq_rate and seq_burst in sys.welcome', async () => {
    const relay = await seqRelay({ rate: 12, burst: 34 });
    live = relay;
    const client = await relay.client();
    expect(client.welcome?.limits).toMatchObject({ seq_rate: 12, seq_burst: 34 });
  });

  it('offers ctx.seq to later modules: the store and the ack tracker', async () => {
    const relay = await seqRelay();
    live = relay;
    const client = await relay.client();
    await client.send('reaction', reaction());
    expect(relay.ctx.seq?.store).toBe(relay.store);
    expect(await relay.ctx.seq?.store.head(relay.sid)).toBe(1);
    expect(relay.ctx.seq?.acks.lowestAcked(relay.sid)).toBe(0);
  });

  it('forgets every connection, session and bucket once 300 clients have come and gone', async () => {
    const relay = await seqRelay();
    live = relay;
    for (let round = 0; round < 10; round += 1) {
      const batch = await Promise.all(Array.from({ length: 30 }, () => relay.client()));
      await Promise.all(batch.map((c) => c.send('reaction', reaction())));
      await Promise.all(batch.map((c) => c.close()));
    }
    await until(() => relay.sequencer.stats().connections === 0);
    expect(relay.sequencer.stats()).toEqual({
      connections: 0,
      sessions: 0,
      buckets: 0,
      queued: 0,
      durablePending: 0,
    });
  }, 30_000);
});
