/**
 * The session state machine (B053, CT-API-SESSIONS, CT-WS-CONTROL): a pure function from a state
 * and a lifecycle event to the next state. Sessions are created `live` (`pending` is the B008
 * default, kept for rows written before this lane, and behaves like `live`).
 *
 * | From              | Event           | To      |
 * | ----------------- | --------------- | ------- |
 * | live, pending     | `host_lost`     | paused  |
 * | paused, pending   | `host_returned` | live    |
 * | live, paused, pending | `end`       | ended   |
 * | paused            | `expire`        | expired |
 *
 * Everything else throws `SessionStateError` (ended and expired are final).
 *
 * Owns: the table. Must not: touch storage (the repository applies a transition conditionally).
 */

/** A session state (the set of `control.session_state.state`). */
export type SessionState = 'pending' | 'live' | 'paused' | 'ended' | 'expired';

/** Every session state. */
export const SESSION_STATES: readonly SessionState[] = [
  'pending',
  'live',
  'paused',
  'ended',
  'expired',
];

/** What can happen to a session. */
export type LifecycleEvent = 'host_lost' | 'host_returned' | 'end' | 'expire';

/** Every lifecycle event. */
export const LIFECYCLE_EVENTS: readonly LifecycleEvent[] = [
  'host_lost',
  'host_returned',
  'end',
  'expire',
];

/** A transition the table does not allow. */
export class SessionStateError extends Error {
  override name = 'SessionStateError';
  constructor(
    readonly from: SessionState,
    readonly event: LifecycleEvent,
  ) {
    super(`a ${from} session cannot ${event.replace('_', ' ')}`);
  }
}

const TABLE: Readonly<Record<LifecycleEvent, Partial<Record<SessionState, SessionState>>>> = {
  host_lost: { live: 'paused', pending: 'paused' },
  host_returned: { paused: 'live', pending: 'live' },
  end: { live: 'ended', paused: 'ended', pending: 'ended' },
  expire: { paused: 'expired' },
};

/** The state after `event` in `from`; throws SessionStateError when the table has none. */
export function transition(from: SessionState, event: LifecycleEvent): SessionState {
  const to = TABLE[event][from];
  if (to === undefined) throw new SessionStateError(from, event);
  return to;
}

/** The states `event` may start from (for the conditional UPDATE). */
export function sourcesOf(event: LifecycleEvent): SessionState[] {
  return SESSION_STATES.filter((s) => TABLE[event][s] !== undefined);
}

/** True for a state a session never leaves. */
export const isFinal = (state: SessionState): boolean => state === 'ended' || state === 'expired';
