/**
 * Droppable frames (B046; tests "backpressure.ephemeral-drop.test.ts", acceptance 3, guardrail
 * "ephemeral frames are droppable and never retried"): above 1 MiB buffered, presence and cursor
 * frames to that connection are dropped (counted), while sequenced frames are still queued, in
 * order; below it, they are sent. The decision reads sizes only.
 */
import { describe, expect, it } from 'vitest';
import { controllerUnit, frameText, KiB, presenceText } from './helpers.js';

describe('droppable vs sequenced (acceptance 3)', () => {
  it('drops presence over 1 MiB, keeps queueing sequenced frames in order', () => {
    const u = controllerUnit();
    const conn = u.connect();
    expect(u.sendEphemeral(conn, presenceText(u.sid))).toBe('queued');
    for (let seq = 1; seq <= 11; seq += 1) u.send(conn, frameText(u.sid, seq));
    expect(conn.buffered).toBeGreaterThan(1024 * KiB);
    const before = conn.texts.length;
    for (let i = 0; i < 20; i += 1)
      expect(u.sendEphemeral(conn, presenceText(u.sid))).toBe('dropped');
    expect(conn.texts.length).toBe(before);
    expect(u.recorded.count('relay_backpressure_dropped_total')).toBe(20);
    for (let seq = 12; seq <= 14; seq += 1)
      expect(u.send(conn, frameText(u.sid, seq))).toBe('queued');
    expect(conn.seqs()).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
  });

  it('sends presence again once the connection drained', () => {
    const u = controllerUnit();
    const conn = u.connect();
    for (let seq = 1; seq <= 11; seq += 1) u.send(conn, frameText(u.sid, seq));
    expect(u.sendEphemeral(conn, presenceText(u.sid))).toBe('dropped');
    conn.drain();
    expect(u.sendEphemeral(conn, presenceText(u.sid))).toBe('queued');
  });

  it('a frame that would carry the buffer past 1 MiB is dropped too', () => {
    const u = controllerUnit();
    const conn = u.connect();
    conn.buffered = 1024 * KiB - 10;
    expect(u.sendEphemeral(conn, presenceText(u.sid))).toBe('dropped');
  });
});
