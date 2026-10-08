/**
 * The connection state machine (B040): every legal move is allowed and every other one throws
 * IllegalTransitionError (table-driven over all 25 pairs), including the card's
 * `closed -> active` and `active -> authenticating`; activity is timed by the given clock.
 */
import { describe, expect, it } from 'vitest';
import {
  canTransition,
  CONN_STATES,
  createConnectionMachine,
  IllegalTransitionError,
  type ConnState,
} from '../../src/connection/machine.js';

/** The legal moves, written out independently of the implementation's table. */
const LEGAL = new Set([
  'awaiting_hello>authenticating',
  'awaiting_hello>draining',
  'awaiting_hello>closed',
  'authenticating>active',
  'authenticating>draining',
  'authenticating>closed',
  'active>draining',
  'active>closed',
  'draining>closed',
]);

/** A machine walked to `state` along legal moves. */
function machineIn(state: ConnState) {
  const machine = createConnectionMachine(() => 0);
  const path: Record<ConnState, ConnState[]> = {
    awaiting_hello: [],
    authenticating: ['authenticating'],
    active: ['authenticating', 'active'],
    draining: ['authenticating', 'active', 'draining'],
    closed: ['closed'],
  };
  for (const step of path[state]) machine.transition(step);
  expect(machine.state).toBe(state);
  return machine;
}

const pairs = CONN_STATES.flatMap((from) => CONN_STATES.map((to) => [from, to] as const));

describe('transitions', () => {
  it.each(pairs.filter(([from, to]) => LEGAL.has(`${from}>${to}`)))(
    'allows %s -> %s',
    (from, to) => {
      const machine = machineIn(from);
      machine.transition(to);
      expect(machine.state).toBe(to);
      expect(canTransition(from, to)).toBe(true);
    },
  );

  it.each(pairs.filter(([from, to]) => !LEGAL.has(`${from}>${to}`)))(
    'refuses %s -> %s with IllegalTransitionError',
    (from, to) => {
      const machine = machineIn(from);
      expect(() => machine.transition(to)).toThrow(IllegalTransitionError);
      expect(machine.state).toBe(from);
      expect(canTransition(from, to)).toBe(false);
    },
  );

  it("names both states for the card's cases: closed -> active, active -> authenticating", () => {
    const closed = machineIn('closed');
    expect(() => closed.transition('active')).toThrow(
      expect.objectContaining({ name: 'IllegalTransitionError', from: 'closed', to: 'active' }),
    );
    const active = machineIn('active');
    expect(() => active.transition('authenticating')).toThrow(
      'a connection cannot go from active to authenticating',
    );
  });

  it('starts in awaiting_hello', () => {
    expect(createConnectionMachine(() => 0).state).toBe('awaiting_hello');
  });
});

describe('activity', () => {
  it('starts at the creation time and moves with touch()', () => {
    let now = 1_000;
    const machine = createConnectionMachine(() => now);
    expect(machine.lastActivityAt).toBe(1_000);
    now = 4_500;
    expect(machine.lastActivityAt).toBe(1_000);
    machine.touch();
    expect(machine.lastActivityAt).toBe(4_500);
  });
});
