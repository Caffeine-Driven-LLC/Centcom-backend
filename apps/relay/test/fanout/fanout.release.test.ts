/**
 * OrderedRelease (B044; tests "fanout.release.test.ts", acceptance 4): offering seq 12 before 11
 * releases 11 then 12; if 11 never arrives within 250 ms `onGap` fires with (11, 11) and nothing
 * from 12 on is released until the gap is filled; more than 2 000 waiting frames report the gap at
 * once; old and repeated offers are ignored; `reset` and idle sessions are forgotten.
 */
import { describe, expect, it } from 'vitest';
import { createOrderedRelease } from '../../src/fanout/release.js';
import type { StoredFrame } from '../../src/seq/types.js';
import { manualTimers } from './helpers.js';

const frame = (seq: number): StoredFrame =>
  ({
    v: 1,
    t: 'event',
    id: `msg_${seq}`,
    sid: 's',
    from: 'srv',
    ts: 'x',
    seq,
    k: 'reaction',
  }) as StoredFrame;

function setup(opts: { maxBuffered?: number; clock?: () => number } = {}) {
  const timers = manualTimers();
  const released: number[] = [];
  const gaps: [string, number, number][] = [];
  const release = createOrderedRelease({
    release: (_sid, f) => released.push(f.seq),
    setTimer: timers.setTimer,
    ...opts,
  });
  release.onGap((sid, from, to) => gaps.push([sid, from, to]));
  return { timers, released, gaps, release };
}

describe('OrderedRelease', () => {
  it('releases 11 then 12 when 12 is offered first (acceptance 4)', () => {
    const { release, released } = setup();
    release.offer('s', frame(10));
    release.offer('s', frame(12));
    expect(released).toEqual([10]);
    release.offer('s', frame(11));
    expect(released).toEqual([10, 11, 12]);
    expect(release.waiting()).toBe(0);
  });

  it('reports a gap after 250 ms and holds everything past it (acceptance 4)', () => {
    const { release, released, gaps, timers } = setup();
    release.offer('s', frame(10));
    release.offer('s', frame(12));
    release.offer('s', frame(13));
    expect(timers.pending.map((t) => t.ms)).toEqual([250]);
    timers.fire();
    expect(gaps).toEqual([['s', 11, 11]]);
    release.offer('s', frame(14));
    expect(released).toEqual([10]);
    // Reported once while open.
    timers.fire();
    expect(gaps).toHaveLength(1);
    release.offer('s', frame(11));
    expect(released).toEqual([10, 11, 12, 13, 14]);
  });

  it('reports at once past 2 000 waiting frames', () => {
    const { release, gaps } = setup({ maxBuffered: 5 });
    release.offer('s', frame(1));
    for (let seq = 3; seq <= 8; seq++) release.offer('s', frame(seq));
    expect(gaps).toEqual([['s', 2, 2]]);
  });

  it('ignores old and repeated offers, keeps sessions apart, and resets', () => {
    const { release, released } = setup();
    release.offer('a', frame(5));
    release.offer('a', frame(5));
    release.offer('a', frame(4));
    release.offer('b', frame(1));
    expect(released).toEqual([5, 1]);
    expect(release.expected('a')).toBe(6);
    expect(release.sessions()).toBe(2);
    release.offer('a', frame(8));
    expect(release.waiting()).toBe(1);
    release.reset('a');
    expect(release.waiting()).toBe(0);
    expect(release.expected('a')).toBeNull();
    release.reset('nothing');
    release.offer('a', frame(20));
    expect(released.at(-1)).toBe(20);
    release.stop();
  });

  it('forgets idle sessions with nothing waiting', () => {
    let now = 0;
    const { release } = setup({ clock: () => now });
    release.offer('old', frame(1));
    now = 10 * 60 * 1000;
    for (let i = 0; i < 1_000; i++) release.offer('new', frame(i + 1));
    expect(release.expected('old')).toBeNull();
    expect(release.sessions()).toBe(1);
  });
});
