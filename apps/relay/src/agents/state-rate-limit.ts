/**
 * The `agent.state` rate limit (B057; CT-WS-SESSION-EVENTS: senders SHOULD coalesce `agent.state`
 * to at most 2 per second): at most STATE_FRAMES_PER_SECOND frames per agent in any one-second
 * window (sliding), counted by B009's Redis rate limiter so every node shares the count. Excess
 * frames are dropped before sequencing (the relay never drops a sequenced frame) and only counted.
 *
 * - Key: `relay:agents:rl:<sid>:<agt>`, window 1 s.
 * - Redis unreachable: a per-node sliding window takes over (the same rule on this node's frames
 *   only), so the limit never blocks state changes outright.
 *
 * Owns: the count. Must not: look at the state name (the registry drops identical repeats).
 */
import type { RateLimitStore } from '@centcom/core';

/** Frames per agent per second (card scope). */
export const STATE_FRAMES_PER_SECOND = 2;
/** The window, in seconds. */
const WINDOW_S = 1;
/** Most agents the per-node fallback tracks. */
const LOCAL_MAX = 10_000;

/** Limits `agent.state` frames per agent. */
export interface StateRateLimiter {
  /** True when the frame may go on. */
  allow(sid: string, agentId: string): Promise<boolean>;
}

/** The limiter over `store`, with `clock` in milliseconds (for the fallback). */
export function createStateRateLimiter(deps: {
  store: Pick<RateLimitStore, 'consume'>;
  clock: () => number;
  perSecond?: number;
}): StateRateLimiter {
  const perSecond = deps.perSecond ?? STATE_FRAMES_PER_SECOND;
  const local = new Map<string, number[]>();
  const localAllow = (key: string): boolean => {
    const now = deps.clock();
    const recent = (local.get(key) ?? []).filter((at) => now - at < WINDOW_S * 1000);
    const allowed = recent.length < perSecond;
    if (allowed) recent.push(now);
    local.delete(key);
    local.set(key, recent);
    if (local.size > LOCAL_MAX) {
      const oldest = local.keys().next().value;
      if (oldest !== undefined) local.delete(oldest);
    }
    return allowed;
  };
  return {
    async allow(sid, agentId) {
      const key = `relay:agents:rl:${sid}:${agentId}`;
      try {
        return (await deps.store.consume(key, perSecond, WINDOW_S)).allowed;
      } catch {
        return localAllow(key);
      }
    },
  };
}
