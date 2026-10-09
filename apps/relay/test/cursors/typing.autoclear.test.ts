/**
 * Typing auto-clear (B048; tests "typing.autoclear.test.ts", acceptance 4, guardrail "cleared by the
 * relay's own timer"): a member's `activity: "typing"` not refreshed for 5 s (within 0.1 s) gives
 * exactly one `presence.update` for that member with `activity: "idle"` and the same `status`; a
 * refresh within 5 s resets the timer; another activity, or leaving the session, clears it. The
 * clear goes through B047's service (its limits: late, never early).
 */
import { newId } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { createTypingTracker } from '../../src/cursors/typing.js';
import { presenceOf, presenceUnit } from '../presence/helpers.js';

function typingUnit() {
  const u = presenceUnit();
  const typing = createTypingTracker({
    presence: u.presence,
    ttlMs: 5_000,
    clock: u.time.now,
    setTimer: (fn, ms) => u.time.setTimer(fn, ms),
    metrics: u.recorded.metrics,
  });
  u.presence.onUpdate((sid, mid, p, nowMs) => typing.observe(sid, mid, p, nowMs));
  return { ...u, typing };
}

describe('typing cleared after 5 s (acceptance 4)', () => {
  it('exactly one idle update at 5 s, with the same status', async () => {
    const u = typingUnit();
    const member = newId('mem');
    const typist = u.join(member);
    const watcher = u.join();
    const t0 = u.time.now();
    await u.update(typist, { status: 'busy', activity: 'typing', agent_count: 2 });
    u.time.advanceTo(t0 + 4_900);
    expect(presenceOf(watcher)).toEqual([
      [member, { status: 'busy', activity: 'typing', agent_count: 2 }],
    ]);
    u.time.advanceTo(t0 + 5_000);
    expect(presenceOf(watcher)).toEqual([
      [member, { status: 'busy', activity: 'typing', agent_count: 2 }],
      [member, { status: 'busy', activity: 'idle', agent_count: 2 }],
    ]);
    u.time.advanceTo(t0 + 60_000);
    expect(presenceOf(watcher)).toHaveLength(2);
    expect(u.recorded.count('relay_typing_cleared_total')).toBe(1);
  });

  it('a refresh within 5 s resets the timer', async () => {
    const u = typingUnit();
    const typist = u.join();
    const watcher = u.join();
    const t0 = u.time.now();
    await u.update(typist, { status: 'online', activity: 'typing' });
    u.time.advanceTo(t0 + 3_000);
    await u.update(typist, { status: 'online', activity: 'typing' });
    u.time.advanceTo(t0 + 7_900);
    expect(presenceOf(watcher).some(([, p]) => p['activity'] === 'idle')).toBe(false);
    u.time.advanceTo(t0 + 8_000);
    expect(presenceOf(watcher).at(-1)?.[1]).toEqual({ status: 'online', activity: 'idle' });
  });

  it('another activity clears it: no idle from the relay', async () => {
    const u = typingUnit();
    const typist = u.join();
    const watcher = u.join();
    const t0 = u.time.now();
    await u.update(typist, { status: 'online', activity: 'typing' });
    u.time.advanceTo(t0 + 2_000);
    await u.update(typist, { status: 'online', activity: 'reviewing' });
    u.time.advanceTo(t0 + 20_000);
    expect(presenceOf(watcher).map(([, p]) => p['activity'])).toEqual(['typing', 'reviewing']);
    expect(u.typing.size()).toBe(0);
  });

  it('leaving the session clears the timer', async () => {
    const u = typingUnit();
    const member = newId('mem');
    const typist = u.join(member);
    await u.update(typist, { status: 'online', activity: 'typing' });
    expect(u.typing.size()).toBe(1);
    u.typing.clear(u.sid, member);
    u.time.advance(20_000);
    expect(u.recorded.count('relay_typing_cleared_total')).toBe(0);
  });
});
