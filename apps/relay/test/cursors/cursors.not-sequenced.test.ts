/**
 * Cursors are never sequenced (B048; tests "cursors.not-sequenced.test.ts", acceptance 5): 1 000
 * cursors through the stages as on a relay (cursors at 36, sequencing at 40, fan-out at 50) leave
 * `head` at 0, the hot buffer and the durable log empty, and none of the frames sent has a `seq`.
 */
import { describe, expect, it } from 'vitest';
import { cursorStage } from '../../src/cursors/stage.js';
import { createCursorThrottle } from '../../src/cursors/throttle.js';
import { resumeUnit } from '../resume/helpers.js';
import { CONFIG, ctOf, cursorsOf, fakeTime } from './helpers.js';

describe('not sequenced (acceptance 5)', () => {
  it('head unchanged after 1 000 cursors; nothing buffered or logged', async () => {
    const u = resumeUnit();
    const time = fakeTime();
    const throttle = createCursorThrottle({
      rooms: u.rooms,
      config: { ...CONFIG, inPerSecond: 1_000 },
      clock: time.now,
      setTimer: (fn, ms) => time.setTimer(fn, ms),
    });
    const stage = cursorStage({ throttle, clock: time.now });
    const sender = u.join();
    const peer = u.join();
    for (let i = 0; i < 1_000; i += 1) {
      const frame = { v: 1, t: 'presence', sid: u.sid, k: 'presence.cursor', ct: ctOf(100) };
      const fc = { connection: sender, raw: '', frame, state: {} };
      await stage(fc, () =>
        u.sequencer.stage(fc, () => u.fanout.stage(fc, () => Promise.resolve())),
      );
      time.advance(10);
    }
    expect(await u.store.head(u.sid)).toBe(0);
    expect(await u.store.range(u.sid, 0, 100)).toEqual([]);
    expect(u.log.frames(u.sid)).toEqual([]);
    const sent = cursorsOf(peer);
    expect(sent.length).toBeGreaterThan(0);
    for (const f of sent) expect(f).not.toHaveProperty('seq');
    throttle.stop();
  });
});
