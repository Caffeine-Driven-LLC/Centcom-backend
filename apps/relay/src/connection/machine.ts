/**
 * The connection state machine (B040): where one connection is in its life, with only the legal
 * moves allowed.
 *
 * `awaiting_hello` (upgraded, no frame yet) → `authenticating` (the hello is being checked, B038)
 * → `active` (welcomed: heartbeats run) → `draining` (the relay started closing it) → `closed`.
 * Any state but `closed` may go straight to `closed` (the peer left, the socket dropped), and
 * `awaiting_hello` and `authenticating` may go to `draining` (a refused handshake). Nothing leaves
 * `closed`, nothing goes back, and a state cannot be skipped forward (`awaiting_hello` → `active`).
 *
 * Owns: the states and the transition table. Must not: touch the socket.
 */

/** A connection's state. */
export type ConnState = 'awaiting_hello' | 'authenticating' | 'active' | 'draining' | 'closed';

/** The states, in life order. */
export const CONN_STATES: readonly ConnState[] = Object.freeze([
  'awaiting_hello',
  'authenticating',
  'active',
  'draining',
  'closed',
]);

/** The legal moves: from each state, where it may go. */
export const TRANSITIONS: Readonly<Record<ConnState, readonly ConnState[]>> = Object.freeze({
  awaiting_hello: Object.freeze(['authenticating', 'draining', 'closed'] as const),
  authenticating: Object.freeze(['active', 'draining', 'closed'] as const),
  active: Object.freeze(['draining', 'closed'] as const),
  draining: Object.freeze(['closed'] as const),
  closed: Object.freeze([] as const),
});

/** A move the table does not allow; a bug in the caller. */
export class IllegalTransitionError extends Error {
  constructor(
    readonly from: ConnState,
    readonly to: ConnState,
  ) {
    super(`a connection cannot go from ${from} to ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

/** One connection's state and its last inbound activity (server time). */
export interface ConnectionMachine {
  readonly state: ConnState;
  /** Server time (ms) of the last inbound frame; the creation time before any. */
  readonly lastActivityAt: number;
  /** Moves to `to`; throws IllegalTransitionError when the table does not allow it. */
  transition(to: ConnState): void;
  /** Records inbound activity now. */
  touch(): void;
}

/** True when `from` may move to `to`. */
export const canTransition = (from: ConnState, to: ConnState): boolean =>
  TRANSITIONS[from].includes(to);

/** A machine in `awaiting_hello`, timed by `clock` (ms). */
export function createConnectionMachine(clock: () => number): ConnectionMachine {
  let state: ConnState = 'awaiting_hello';
  let lastActivityAt = clock();
  return {
    get state() {
      return state;
    },
    get lastActivityAt() {
      return lastActivityAt;
    },
    transition(to) {
      if (!canTransition(state, to)) throw new IllegalTransitionError(state, to);
      state = to;
    },
    touch() {
      lastActivityAt = clock();
    },
  };
}
