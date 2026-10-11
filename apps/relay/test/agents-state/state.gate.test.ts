/**
 * B058 gate (acceptance 3): a first state is admitted, an identical consecutive one is
 * `drop_duplicate`, at most 2 changes in any 1 s window per agent (the third is `drop_rate`), and
 * windows are per agent; a property test over random sequences checks the window rule.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createStateGate, GATE_WINDOW_MS } from '../../src/agents/state/dedupe.js';

const clockAt = (ms: number) => {
  const clock = { t: ms, now: () => clock.t };
  return clock;
};

describe('createStateGate (acceptance 3)', () => {
  it('admits, drops a duplicate, and drops the third change within a second', () => {
    const clock = clockAt(0);
    const gate = createStateGate({ clock });
    expect(gate.admit('agt_a', 'thinking')).toBe('send');
    expect(gate.admit('agt_a', 'thinking')).toBe('drop_duplicate');
    clock.t = 100;
    expect(gate.admit('agt_a', 'planning')).toBe('send');
    clock.t = 200;
    expect(gate.admit('agt_a', 'searching')).toBe('drop_rate');
    clock.t = 1_000;
    expect(gate.admit('agt_a', 'searching')).toBe('send');
  });

  it('keeps windows per agent', () => {
    const clock = clockAt(0);
    const gate = createStateGate({ clock });
    for (const s of ['thinking', 'planning']) expect(gate.admit('agt_a', s)).toBe('send');
    expect(gate.admit('agt_a', 'searching')).toBe('drop_rate');
    for (const s of ['thinking', 'planning']) expect(gate.admit('agt_b', s)).toBe('send');
  });

  it('never admits more than 2 changes in any 1 s window, nor a repeat (property)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            dt: fc.integer({ min: 0, max: 700 }),
            agent: fc.constantFrom('agt_a', 'agt_b'),
            state: fc.constantFrom('thinking', 'planning', 'searching', 'idle'),
          }),
          { maxLength: 60 },
        ),
        (steps) => {
          const clock = clockAt(0);
          const gate = createStateGate({ clock });
          const sent = new Map<string, { t: number; state: string }[]>();
          for (const step of steps) {
            clock.t += step.dt;
            if (gate.admit(step.agent, step.state) !== 'send') continue;
            const list = sent.get(step.agent) ?? [];
            const prior = list.at(-1);
            if (prior !== undefined && prior.state === step.state) return false;
            list.push({ t: clock.t, state: step.state });
            sent.set(step.agent, list);
            if (list.filter((s) => clock.t - s.t < GATE_WINDOW_MS).length > 2) return false;
          }
          return true;
        },
      ),
    );
  });
});
