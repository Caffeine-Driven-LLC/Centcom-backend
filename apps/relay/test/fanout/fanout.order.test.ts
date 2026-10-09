/**
 * Delivery order (B044; tests "fanout.order.test.ts", acceptance 1): with 5 members connected, a
 * frame from member A reaches all 5 (A's copy is its echo) with the same `seq`; over a
 * 10 000-frame run with 8 concurrent senders every connection receives every frame exactly once,
 * in strictly increasing `seq`. A property test does the same over random interleavings.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fanoutUnit, reactionFrame, type TextConnection } from './helpers.js';

const strictlyIncreasing = (seqs: number[]): boolean =>
  seqs.every((s, i) => i === 0 || s > (seqs[i - 1] ?? 0));

describe('fan-out order', () => {
  it('delivers a frame to all 5 members, the sender included, with one seq (acceptance 1)', async () => {
    const u = fanoutUnit();
    const conns = Array.from({ length: 5 }, () => u.join());
    const stored = await u.send(conns[0] as TextConnection, reactionFrame(u.sid));
    for (const conn of conns) {
      expect(conn.frames()).toEqual([stored]);
    }
    // The sender's copy is its only echo (B041 delegated it).
    expect((conns[0] as TextConnection).texts).toHaveLength(1);
  });

  it('keeps every connection in strict seq order over 10 000 frames from 8 senders (acceptance 1)', async () => {
    const u = fanoutUnit();
    const senders = Array.from({ length: 8 }, () => u.join());
    const watchers = Array.from({ length: 2 }, () => u.join());
    const runs = senders.map(async (conn) => {
      for (let i = 0; i < 1_250; i++) await u.send(conn, reactionFrame(u.sid));
    });
    await Promise.all(runs);
    const all = Array.from({ length: 10_000 }, (_, i) => i + 1);
    for (const conn of [...senders, ...watchers]) {
      const seqs = conn.seqs();
      expect(strictlyIncreasing(seqs)).toBe(true);
      expect(seqs).toEqual(all);
    }
  });

  it('holds for any interleaving of senders (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 1, maxLength: 60 }),
        async (order) => {
          const u = fanoutUnit();
          const conns = Array.from({ length: 4 }, () => u.join());
          await Promise.all(
            order.map((i) => u.send(conns[i] as TextConnection, reactionFrame(u.sid))),
          );
          for (const conn of conns) {
            expect(conn.seqs()).toEqual(Array.from({ length: order.length }, (_, i) => i + 1));
          }
        },
      ),
      { numRuns: 60 },
    );
  });

  it('delivers only to the room of the sender’s authenticated session', async () => {
    const u = fanoutUnit();
    const a = u.join();
    const elsewhere = u.join(`ses_${'Z'.repeat(26)}`);
    // The frame claims another session; the connection's own session decides.
    await u.send(a, reactionFrame(u.sid, { sid: `ses_${'Z'.repeat(26)}` }));
    expect(a.texts).toHaveLength(1);
    expect(elsewhere.texts).toHaveLength(0);
  });
});
