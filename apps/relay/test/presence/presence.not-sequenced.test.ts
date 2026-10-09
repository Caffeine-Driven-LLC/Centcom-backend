/**
 * Presence is never sequenced (B047; tests "presence.not-sequenced.test.ts", acceptance 3,
 * guardrail "never sequenced, buffered, replayed or stored durably"): updates go through the
 * stages as on a relay (presence at 35, then sequencing at 40, fan-out at 50) and none reaches
 * sequencing: `head` stays 0, the hot buffer and the durable log stay empty, the frames that go out
 * have no `seq`, and a resume replays none of them.
 */
import { describe, expect, it } from 'vitest';
import { presenceStage } from '../../src/presence/stage.js';
import { createPresence } from '../../src/presence/service.js';
import { createMemoryPresenceStore } from '../../src/presence/store.js';
import { reactionFrame, resumedOf, resumeUnit, seqsOf } from '../resume/helpers.js';
import { CONFIG, fakeTime, ONLINE_IDLE } from './helpers.js';

describe('not sequenced (acceptance 3)', () => {
  it('leaves head, the hot buffer, the durable log and replay untouched', async () => {
    const u = resumeUnit();
    const time = fakeTime();
    const presence = createPresence({
      store: createMemoryPresenceStore(time.now),
      rooms: u.rooms,
      config: CONFIG,
      nodeId: () => 'node-a',
      clock: time.now,
      setTimer: (fn, ms) => time.setTimer(fn, ms),
    });
    const stage = presenceStage({ service: presence, clock: time.now });
    const sender = u.join();
    const watcher = u.join();
    const send = async (frame: Record<string, unknown>) => {
      const fc = { connection: sender, raw: JSON.stringify(frame), frame, state: {} };
      await stage(fc, () =>
        u.sequencer.stage(fc, () => u.fanout.stage(fc, () => Promise.resolve())),
      );
    };
    for (let i = 0; i < 20; i += 1) {
      await send({ v: 1, t: 'presence', sid: u.sid, k: 'presence.update', p: ONLINE_IDLE });
      time.advance(1_000);
    }
    expect(await u.store.head(u.sid)).toBe(0);
    expect(await u.store.range(u.sid, 0, 100)).toEqual([]);
    expect(u.log.frames(u.sid)).toEqual([]);
    const presenceFrames = watcher.frames().filter((f) => f['t'] === 'presence');
    expect(presenceFrames.length).toBeGreaterThan(0);
    for (const f of presenceFrames) expect(f).not.toHaveProperty('seq');
    // A sequenced frame still is, and a resume replays only it.
    await send(reactionFrame(u.sid));
    expect(await u.store.head(u.sid)).toBe(1);
    const { conn } = await u.connect(0);
    await u.settled(conn);
    expect(seqsOf(conn)).toEqual([1]);
    expect(conn.frames().some((f) => f['t'] === 'presence')).toBe(false);
    expect(resumedOf(conn)).toEqual([{ from_seq: 1, to_seq: 1, count: 1 }]);
  });
});
