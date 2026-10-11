/**
 * B067 recording (acceptance 1, 3; failure modes; guardrail: never on the hot path):
 *
 * - A replayed scenario of joins and leaves: a reconnect inside the 10 s grace writes no
 *   disconnected/connected pair (as B047's presence service suppresses it); a leave past the grace
 *   writes one disconnected at the time the last connection closed, with its reason (4403 kicked,
 *   1006 timeout, else closed); a second connection never writes a second connected.
 * - 1 000 activity touches within a minute on one connection give at most one last-seen write per
 *   60 s (counted at the writer).
 * - The buffer is written every second or at 200 events, and never by the call itself; touches
 *   wait apart (the latest per member), so a minute's sweep over 12 000 connections drops nothing.
 * - A batch Postgres refuses (an integrity error) is dropped, counted, and does not block later
 *   writes; shutdown writes members still in their grace offline.
 * - Database down: events wait and are written in order once it is back; past 10 000 the oldest
 *   are dropped and counted.
 * - An offline event for a member not online is ignored (debug log).
 */
import { newId } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import type { HistoryEvent } from '../../src/presence-history/ports.js';
import {
  createConnectionEvents,
  PresenceHistoryRecorder,
  reasonOf,
  type HistoryTimer,
} from '../../src/presence-history/recorder.js';
import { captureLogger, recordingMetrics } from '../helpers.js';

/** Timers run by hand, with a clock. */
function manual() {
  const clock = { now: Date.parse('2026-10-11T12:00:00.000Z') };
  const timers: { at: number; fn: () => void; cancelled: boolean }[] = [];
  return {
    clock,
    setTimer(fn: () => void, ms: number): HistoryTimer {
      const t = { at: clock.now + ms, fn, cancelled: false };
      timers.push(t);
      return { cancel: () => (t.cancelled = true) };
    },
    /** Moves the clock and runs what came due. */
    advance(ms: number) {
      clock.now += ms;
      for (const t of timers.filter((x) => !x.cancelled && x.at <= clock.now)) {
        t.cancelled = true;
        t.fn();
      }
    },
  };
}

function env(fail: { on: boolean; error?: unknown } = { on: false }) {
  const time = manual();
  const written: HistoryEvent[][] = [];
  const captured = captureLogger();
  const recorded = recordingMetrics();
  const recorder = new PresenceHistoryRecorder({
    writer: {
      write(events) {
        if (fail.on) return Promise.reject(fail.error ?? new Error('db down'));
        written.push([...events]);
        return Promise.resolve();
      },
    },
    logger: captured.logger,
    metrics: recorded.metrics,
    setTimer: (fn, ms) => time.setTimer(fn, ms),
  });
  const events = createConnectionEvents({
    recorder,
    graceMs: 10_000,
    clock: () => time.clock.now,
    setTimer: (fn, ms) => time.setTimer(fn, ms),
  });
  const all = () => written.flat();
  return { time, written, all, recorder, events, captured, recorded, fail };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('online and offline (acceptance 1)', () => {
  it('a reconnect inside the grace writes no disconnected/connected pair', async () => {
    const e = env();
    const [sid, mid, dev] = [newId('ses'), newId('mem'), newId('dev')];
    const t0 = e.time.clock.now;
    e.events.joined(sid, mid, dev);
    e.time.advance(5_000);
    e.events.left(sid, mid, dev, () => 1000);
    e.time.advance(9_999);
    e.events.joined(sid, mid, dev);
    e.time.advance(60_000);
    await e.recorder.flush();
    expect(e.all().map((x) => x.kind)).toEqual(['connected']);
    expect(e.all()[0]?.at.getTime()).toBe(t0);
  });

  it('a leave past the grace writes one disconnected, at the close time, with its reason', async () => {
    const e = env();
    const [sid, mid, dev] = [newId('ses'), newId('mem'), newId('dev')];
    e.events.joined(sid, mid, dev);
    e.events.joined(sid, mid, dev); // a second connection: still one connected
    e.time.advance(1_000);
    const closedAt = e.time.clock.now;
    e.events.left(sid, mid, dev, () => 4403);
    e.time.advance(10_000);
    await e.recorder.flush();
    expect(e.all().map((x) => [x.kind, x.at.getTime()])).toEqual([
      ['connected', closedAt - 1_000],
      ['disconnected', closedAt],
    ]);
    expect(e.all()[1]).toMatchObject({ reason: 'kicked', deviceId: dev });
  });

  it('maps close codes to reasons', () => {
    expect([4403, 1006, 1000, 1001, 4409, undefined].map(reasonOf)).toEqual([
      'kicked',
      'timeout',
      'closed',
      'closed',
      'closed',
      'closed',
    ]);
  });

  it('ignores an offline event for a member not online (out of order)', async () => {
    const e = env();
    e.recorder.onDisconnected({
      sid: newId('ses'),
      memberId: newId('mem'),
      deviceId: null,
      at: new Date(e.time.clock.now),
      reason: 'closed',
    });
    await e.recorder.flush();
    expect(e.all()).toEqual([]);
    expect(e.captured.raw()).toContain('presence_history.out_of_order');
  });
});

describe('last-seen throttling (acceptance 3)', () => {
  it('1 000 touches within a minute on one connection: at most one write per 60 s', async () => {
    const e = env();
    const [sid, mid, dev] = [newId('ses'), newId('mem'), newId('dev')];
    e.events.joined(sid, mid, dev);
    for (let i = 0; i < 1_000; i++) {
      e.time.clock.now += 60; // 1 000 touches over 60 s
      e.recorder.touch({ sid, memberId: mid, deviceId: dev, at: new Date(e.time.clock.now) });
    }
    await e.recorder.flush();
    const touches = e.all().filter((x) => x.kind === 'touch');
    expect(touches.length).toBeLessThanOrEqual(1);
    for (let i = 1; i < touches.length; i++) {
      expect(
        (touches[i]?.at.getTime() ?? 0) - (touches[i - 1]?.at.getTime() ?? 0),
      ).toBeGreaterThanOrEqual(60_000);
    }
  });

  it('a member not online is not touched', async () => {
    const e = env();
    e.recorder.touch({ sid: newId('ses'), memberId: newId('mem'), deviceId: null, at: new Date() });
    await e.recorder.flush();
    expect(e.all()).toEqual([]);
  });
});

describe('buffering (guardrail: off the hot path; failure modes)', () => {
  it('writes every second or at 200 events, never during the call', async () => {
    const e = env();
    const sid = newId('ses');
    e.events.joined(sid, newId('mem'), null);
    expect(e.written).toEqual([]);
    e.time.advance(1_000);
    await settle();
    expect(e.written).toHaveLength(1);
    for (let i = 0; i < 200; i++) e.events.joined(sid, newId('mem'), null);
    // The 200th call returned before the write started.
    expect(e.written).toHaveLength(1);
    await settle();
    expect(e.written.at(-1)).toHaveLength(200);
  });

  it('a minute sweep over 12 000 connections drops nothing (touches wait apart, one per member)', async () => {
    const e = env();
    const sid = newId('ses');
    const members = Array.from({ length: 12_000 }, () => newId('mem'));
    for (let i = 0; i < members.length; i += 100) {
      for (const m of members.slice(i, i + 100)) e.events.joined(sid, m, null);
      await settle();
    }
    await e.recorder.flush();
    e.time.clock.now += 60_000;
    for (const m of members) {
      e.recorder.touch({ sid, memberId: m, deviceId: null, at: new Date(e.time.clock.now) });
    }
    expect(e.recorder.pendingTouches).toBe(12_000);
    expect(e.recorder.buffered).toBe(0);
    await e.recorder.flush();
    expect(e.recorded.count('relay_presence_history_dropped_total')).toBe(0);
    expect(e.all().filter((x) => x.kind === 'touch')).toHaveLength(12_000);
    expect(e.all().filter((x) => x.kind === 'connected')).toHaveLength(12_000);
  }, 30_000);

  it('a batch Postgres refuses (integrity error) is dropped and does not block later writes', async () => {
    const e = env({ on: true, error: Object.assign(new Error('fk'), { code: '23503' }) });
    const sid = newId('ses');
    e.events.joined(sid, newId('mem'), null);
    await e.recorder.flush();
    expect(e.recorder.buffered).toBe(0);
    expect(e.recorded.count('relay_presence_history_dropped_total')).toBe(1);
    e.fail.on = false;
    e.events.joined(sid, newId('mem'), null);
    await e.recorder.flush();
    expect(e.all()).toHaveLength(1);
  });

  it('a touch from a failed write is not kept for a member who went offline meanwhile', async () => {
    const e = env({ on: true });
    const [sid, mid] = [newId('ses'), newId('mem')];
    e.events.joined(sid, mid, null);
    e.time.clock.now += 60_000;
    e.recorder.touch({ sid, memberId: mid, deviceId: null, at: new Date(e.time.clock.now) });
    const failing = e.recorder.flush();
    e.recorder.onDisconnected({
      sid,
      memberId: mid,
      deviceId: null,
      at: new Date(e.time.clock.now),
      reason: 'closed',
    });
    await failing;
    expect(e.recorder.pendingTouches).toBe(0);
  });

  it('shutdown writes members still in their grace offline, at their close time', async () => {
    const e = env();
    const [sid, mid] = [newId('ses'), newId('mem')];
    e.events.joined(sid, mid, null);
    e.time.advance(2_000);
    const closedAt = e.time.clock.now;
    e.events.left(sid, mid, null, () => 1001);
    e.time.advance(3_000);
    e.events.stop();
    await e.recorder.flush();
    expect(e.all().map((x) => [x.kind, x.at.getTime()])).toEqual([
      ['connected', closedAt - 2_000],
      ['disconnected', closedAt],
    ]);
    // The cancelled grace timer writes nothing more.
    e.time.advance(20_000);
    await e.recorder.flush();
    expect(e.all()).toHaveLength(2);
  });

  it('database down: events wait, then go in order; past 10 000 the oldest are dropped', async () => {
    const e = env({ on: true });
    const sid = newId('ses');
    const members = Array.from({ length: 10_050 }, () => newId('mem'));
    for (const m of members) e.events.joined(sid, m, null);
    // Drain: the write queued by the 200th event and this one both fail.
    await e.recorder.flush();
    await e.recorder.flush();
    expect(e.recorder.buffered).toBe(10_000);
    expect(e.recorded.count('relay_presence_history_dropped_total')).toBe(50);
    expect(e.recorded.count('relay_presence_history_flush_failures_total')).toBeGreaterThan(0);
    e.fail.on = false;
    await e.recorder.flush();
    const ids = e.all().map((x) => x.memberId);
    expect(ids).toEqual(members.slice(50));
  });
});
