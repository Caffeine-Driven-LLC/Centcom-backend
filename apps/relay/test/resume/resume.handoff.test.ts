/**
 * The live-frame handoff (B042; tests "resume.handoff.test.ts", guardrail "ordered and gapless
 * relative to live frames"): whatever live traffic, resends and event-loop turns interleave with a
 * replay, the resuming connection receives every frame after its `last_seq` exactly once and in
 * `seq` order (a resend made after the resume ended is echoed again, as B041 always does), and
 * `sys.resumed` sits right after the last replayed one. Fast-check drives the
 * interleavings; the resends are the reconnecting member's own unacked frames, whose echoes
 * (B041 duplicates) go through the same hold.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_HELD_FRAMES } from '../../src/fanout/fanout.js';
import { newId, reactionFrame, resumedOf, resumeUnit } from './helpers.js';

type Op = 'send' | 'turn' | 'resend' | 'mine';

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('handoff under random interleavings', () => {
  it('delivers last_seq+1..head once each, in order, around sys.resumed', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 250 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.array(fc.constantFrom<Op>('send', 'turn', 'resend', 'mine'), { maxLength: 80 }),
        async (seeded, at, ops) => {
          const u = resumeUnit();
          await u.seed(seeded);
          // The member that reconnects sent some frames on its earlier connection.
          const member = newId('mem');
          const before = u.join(u.sid, member);
          const mine = Array.from({ length: 5 }, () => reactionFrame(u.sid));
          for (const frame of mine) await u.send(before, frame);
          before.close(1006 as never);
          const head = seeded + mine.length;
          const lastSeq = Math.floor(at * head);
          const sender = u.join();
          const connecting = u.connect(lastSeq, { member });
          let resuming: Awaited<typeof connecting> | undefined;
          void connecting.then((c) => (resuming = c));
          let sent = 0;
          for (const op of ops) {
            if (op === 'turn') await turn();
            else if (op === 'send') {
              await u.send(sender);
              sent += 1;
            } else if (resuming !== undefined) {
              // A resend of an unacked frame (duplicate), or a new frame, from the resumed member.
              const frame = op === 'resend' ? mine[sent % mine.length] : reactionFrame(u.sid);
              await u.send(resuming.conn, frame);
              if (op === 'mine') sent += 1;
            }
          }
          const { conn } = await connecting;
          await u.settled(conn);
          const expected = Array.from({ length: head + sent - lastSeq }, (_, i) => lastSeq + 1 + i);
          // A resend after the resume ended is echoed again with its original seq (B041, at least
          // once; the client drops its own echo by id). Anything else arrives once, in order.
          const resent = new Set(mine.map((f) => f.id));
          let highest = 0;
          const once = conn
            .frames()
            .filter((f) => typeof f['seq'] === 'number')
            .filter((f) => {
              const seq = f['seq'] as number;
              const late = seq <= highest;
              highest = Math.max(highest, seq);
              return !(late && resent.has(f['id'] as string));
            })
            .map((f) => f['seq']);
          expect(once).toEqual(expected);
          const line = conn.frames().map((f) => f['seq'] ?? f['t']);
          const untilResumed = line
            .slice(0, line.indexOf('sys.resumed'))
            .filter((x): x is number => typeof x === 'number');
          expect(untilResumed).toEqual([...untilResumed].sort((x, y) => x - y));
          expect(new Set(untilResumed).size).toBe(untilResumed.length);
          const [resumed] = resumedOf(conn);
          const to = resumed?.['to_seq'] as number;
          expect(resumed?.['count']).toBe(to - lastSeq);
          expect(line[line.indexOf('sys.resumed') - 1] ?? 'sys.welcome').toBe(
            to > lastSeq ? to : 'sys.welcome',
          );
        },
      ),
      { numRuns: 60 },
    );
  });

  it('closes a connection whose hold overflows with 1001 resync', async () => {
    const u = resumeUnit();
    const conn = u.join();
    const hold = u.fanout.hold(conn);
    const sender = u.join();
    for (let i = 0; i <= MAX_HELD_FRAMES; i += 1) await u.send(sender);
    expect(hold.overflowed).toBe(true);
    expect(conn.closedWith).toBe(1001);
    expect(conn.frames().at(-1)).toMatchObject({ t: 'sys.bye', p: { reason: 'resync' } });
  });

  it('skips a late live frame of the replayed range after the hold ended', async () => {
    const u = resumeUnit();
    const conn = u.join();
    const hold = u.fanout.hold(conn);
    hold.end(5);
    u.fanout.sendTo(conn, { seq: 4 } as never);
    u.fanout.sendTo(conn, { seq: 6 } as never);
    u.fanout.sendTo(conn, { seq: 3 } as never);
    expect(conn.frames().map((f) => f['seq'])).toEqual([6, 3]);
  });
});
