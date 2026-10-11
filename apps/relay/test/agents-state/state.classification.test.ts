/**
 * B058 classification (acceptance 1, 2, 6; guardrails): every key of `contracts/state-map.json` is
 * classified exactly once as wire or client-local, the agent-level list equals the "Agent-level
 * states" section of `contracts/09-state-map.md`, the named examples get their verdicts, and the
 * validator is pure and fast (100 000 validations under 200 ms).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateAgentState } from '../../src/agents/state/validator.js';
import {
  AGENT_WIRE_STATES,
  CLIENT_LOCAL_PATTERNS,
  CLIENT_LOCAL_STATES,
  matchesAny,
  splitStates,
  StateMapError,
  UNCLASSIFIED_STATES,
} from '../../src/agents/state/wire-split.js';

const contract = (name: string): string =>
  readFileSync(new URL(`../../../../contracts/${name}`, import.meta.url), 'utf8');

const MAP_KEYS = Object.keys(JSON.parse(contract('state-map.json')) as Record<string, string>);

/** The names and patterns in backticks of the section's "All other keys (...)" sentence. */
function clientLocalSentence(): string[] {
  const md = contract('09-state-map.md');
  const start = md.indexOf('All other keys (');
  const body = md.slice(start, md.indexOf(')', md.indexOf('`host-session`', start)) + 1);
  return [...body.matchAll(/`([a-z][a-z*-]*)`/g)].map((m) => m[1] ?? '');
}

/** The state names in backticks under 09-state-map.md "Agent-level states". */
function agentLevelSection(): string[] {
  const md = contract('09-state-map.md');
  const start = md.indexOf('## Agent-level states');
  const body = md.slice(start, md.indexOf('\n\n', md.indexOf('\n\n', start) + 2));
  return [...body.matchAll(/`([a-z][a-z-]*)`/g)]
    .map((m) => m[1] ?? '')
    .filter((s) => s !== 'agent');
}

describe('the wire / client-local split (acceptance 1)', () => {
  it('classifies every state-map key exactly once', () => {
    for (const key of MAP_KEYS) {
      const inWire = AGENT_WIRE_STATES.has(key);
      const inLocal = CLIENT_LOCAL_STATES.has(key);
      expect(inWire !== inLocal, key).toBe(true);
    }
    expect(AGENT_WIRE_STATES.size + CLIENT_LOCAL_STATES.size).toBe(MAP_KEYS.length);
    expect([...UNCLASSIFIED_STATES]).toEqual([]);
    for (const s of [...AGENT_WIRE_STATES, ...CLIENT_LOCAL_STATES]) expect(MAP_KEYS).toContain(s);
  });

  it('matches the "Agent-level states" section of 09-state-map.md', () => {
    const listed = agentLevelSection();
    expect(listed.length).toBeGreaterThan(20);
    expect([...AGENT_WIRE_STATES].sort()).toEqual([...new Set(listed)].sort());
  });

  it("classifies every name of the section's client-local sentence as local", () => {
    const named = clientLocalSentence();
    expect(named).toEqual(expect.arrayContaining(['provider-*', 'ci-*', 'pr-*', 'host-session']));
    for (const name of named) expect(CLIENT_LOCAL_PATTERNS, name).toContain(name);
    for (const key of MAP_KEYS.filter((k) => matchesAny(k, named))) {
      expect(CLIENT_LOCAL_STATES.has(key), key).toBe(true);
    }
  });

  it('fails at load on a map that lacks an agent-level state, is empty, or classifies a key twice', () => {
    expect(() => splitStates(MAP_KEYS.filter((k) => k !== 'thinking'))).toThrow(StateMapError);
    expect(() => splitStates([])).toThrow(StateMapError);
    expect(() => splitStates(MAP_KEYS, undefined, [...CLIENT_LOCAL_PATTERNS, 'thinking'])).toThrow(
      StateMapError,
    );
  });

  it('leaves a key the contract adds unclassified (unknown at runtime) until it is listed', () => {
    const grown = splitStates([...MAP_KEYS, 'reviewing']);
    expect([...grown.unclassified]).toEqual(['reviewing']);
    expect(grown.local.has('reviewing')).toBe(false);
    expect(validateAgentState('reviewing')).toEqual({ verdict: 'unknown' });
  });
});

describe('validateAgentState (acceptance 2)', () => {
  it('accepts agent-level states, refuses client-local ones, and calls the rest unknown', () => {
    for (const s of ['thinking', 'awaiting-approval']) {
      expect(validateAgentState(s), s).toEqual({ verdict: 'accepted' });
    }
    for (const s of ['offline', 'reconnecting', 'quota-reached', 'teammate-joins']) {
      expect(validateAgentState(s), s).toEqual({ verdict: 'client_local' });
    }
    for (const s of ['dancing', '', 'THINKING', 'thinking ']) {
      expect(validateAgentState(s), s).toEqual({ verdict: 'unknown' });
    }
  });

  it('gives every key of the map its split verdict', () => {
    for (const key of MAP_KEYS) {
      expect(validateAgentState(key).verdict, key).toBe(
        AGENT_WIRE_STATES.has(key) ? 'accepted' : 'client_local',
      );
    }
  });

  it('runs 100 000 validations in under 200 ms (acceptance 6)', () => {
    const names = [...MAP_KEYS, 'dancing'];
    const started = performance.now();
    let accepted = 0;
    for (let i = 0; i < 100_000; i++) {
      if (validateAgentState(names[i % names.length] ?? '').verdict === 'accepted') accepted += 1;
    }
    expect(performance.now() - started).toBeLessThan(200);
    expect(accepted).toBeGreaterThan(0);
  });
});
