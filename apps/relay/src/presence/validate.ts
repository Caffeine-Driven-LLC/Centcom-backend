/**
 * Checking `presence.update.p` (B047, CT-WS-PRESENCE): `status` one of online, away, busy;
 * `activity` one of idle, typing, reviewing, running; `agent_count` a whole number from 0 (and at
 * most 1 000, a member's agents). Only those fields are kept: any other is dropped, never stored
 * or logged.
 *
 * Owns: the payload rule. Must not: keep a field it does not name.
 */
import type { PresenceUpdate } from './types.js';

const STATUS: ReadonlySet<string> = new Set(['online', 'away', 'busy']);
const ACTIVITY: ReadonlySet<string> = new Set(['idle', 'typing', 'reviewing', 'running']);
/** The most agents a presence may report. */
export const MAX_AGENT_COUNT = 1_000;

/** The payload kept, or the pointer of the field that is wrong. */
export function checkPresenceUpdate(
  p: unknown,
): { ok: true; value: PresenceUpdate } | { ok: false; pointer: string } {
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return { ok: false, pointer: '/p' };
  const { status, activity, agent_count: agents } = p as Record<string, unknown>;
  if (typeof status !== 'string' || !STATUS.has(status)) return { ok: false, pointer: '/p/status' };
  if (typeof activity !== 'string' || !ACTIVITY.has(activity)) {
    return { ok: false, pointer: '/p/activity' };
  }
  if (
    agents !== undefined &&
    (typeof agents !== 'number' ||
      !Number.isSafeInteger(agents) ||
      agents < 0 ||
      agents > MAX_AGENT_COUNT)
  ) {
    return { ok: false, pointer: '/p/agent_count' };
  }
  return {
    ok: true,
    value: {
      status: status as PresenceUpdate['status'],
      activity: activity as PresenceUpdate['activity'],
      ...(agents === undefined ? {} : { agent_count: agents }),
    },
  };
}
