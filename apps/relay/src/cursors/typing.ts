/**
 * Typing auto-clear (B048, CT-WS-PRESENCE: "Typing indicators are `presence.update` with
 * `activity: "typing"`, auto-cleared by the relay after 5 s with no refresh"): each member's
 * `presence.update` (B047's `onUpdate`) with `activity: "typing"` (re)starts a RELAY_TYPING_TTL_MS
 * timer; any other activity, or the member leaving the session here, cancels it. When it runs
 * out, the relay itself sends one `presence.update` for the member with `activity: "idle"` and the
 * same `status` (and `agent_count`) through B047's service, so B047's limits apply: it may go out
 * later, never earlier. Nothing a client sends can trigger it.
 *
 * Owns: the timers. Must not: clear a member before its TTL, or keep a timer for a member gone.
 */
import { noopMetrics, type Metrics } from '@centcom/core';
import type { PresenceService, PresenceUpdate } from '../presence/types.js';

/** The card's interface. */
export interface TypingTracker {
  touch(sid: string, mid: string, nowMs: number): void;
  clear(sid: string, mid: string): void;
}

/** A timer that can be cancelled. */
export interface TypingTimer {
  cancel(): void;
}

/** The tracker over B047's service. */
export function createTypingTracker(deps: {
  presence: Pick<PresenceService, 'update'>;
  ttlMs: number;
  clock?: () => number;
  setTimer?: (fn: () => void, ms: number) => TypingTimer;
  metrics?: Metrics;
}): TypingTracker & {
  /** Feeds a member's update: typing touches, anything else clears. */
  observe(sid: string, mid: string, p: PresenceUpdate, nowMs: number): void;
  /** Members with a running timer. */
  size(): number;
  stop(): void;
} {
  const clock = deps.clock ?? Date.now;
  const setTimer =
    deps.setTimer ??
    ((fn: () => void, ms: number): TypingTimer => {
      const handle = setTimeout(fn, ms);
      handle.unref();
      return { cancel: () => clearTimeout(handle) };
    });
  const metrics = deps.metrics ?? noopMetrics;
  const timers = new Map<string, { timer: TypingTimer; last: PresenceUpdate }>();
  const key = (sid: string, mid: string): string => `${sid}\u0000${mid}`;

  const tracker = {
    touch(sid: string, mid: string, _nowMs: number, last?: PresenceUpdate) {
      const k = key(sid, mid);
      const previous = timers.get(k);
      previous?.timer.cancel();
      const value: PresenceUpdate = last ??
        previous?.last ?? { status: 'online', activity: 'typing' };
      const timer = setTimer(() => {
        timers.delete(k);
        metrics.counter('relay_typing_cleared_total').inc();
        deps.presence.update(sid, mid, { ...value, activity: 'idle' }, clock());
      }, deps.ttlMs);
      timers.set(k, { timer, last: value });
    },
    clear(sid: string, mid: string) {
      const k = key(sid, mid);
      timers.get(k)?.timer.cancel();
      timers.delete(k);
    },
    observe(sid: string, mid: string, p: PresenceUpdate, nowMs: number) {
      if (p.activity === 'typing') tracker.touch(sid, mid, nowMs, p);
      else tracker.clear(sid, mid);
    },
    size: () => timers.size,
    stop() {
      for (const { timer } of timers.values()) timer.cancel();
      timers.clear();
    },
  };
  return tracker;
}
