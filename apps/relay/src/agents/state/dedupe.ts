/**
 * The agent state gate (B058, CT-STATE-MAP rule 2: "at most 2 `agent.state` frames per agent per
 * second; identical consecutive states are not re-sent"): per agent, a state equal to the last one
 * admitted is `drop_duplicate`, and a third change within any one-second window (sliding) is
 * `drop_rate`. Only admitted states count.
 *
 * In-process and synchronous: for one process's view (a client, a tool, the relay's fallback).
 * The relay's own cross-node limit is B057's Redis-backed one. At most GATE_MAX_AGENTS agents are
 * remembered (the oldest forgotten first).
 *
 * Owns: the per-agent window. Must not: look at what a state means.
 */

/** Milliseconds since the epoch. */
export interface ClockPort {
  now(): number;
}

/** Changes admitted per agent per window. */
export const GATE_CHANGES_PER_WINDOW = 2;
/** The window. */
export const GATE_WINDOW_MS = 1_000;
/** Agents remembered at most. */
export const GATE_MAX_AGENTS = 10_000;

/** What the gate says about a state. */
export type GateDecision = 'send' | 'drop_duplicate' | 'drop_rate';

/** A gate over `clock`. */
export function createStateGate(opts: { clock: ClockPort }): {
  admit(agentId: string, state: string): GateDecision;
} {
  const agents = new Map<string, { last: string; times: number[] }>();
  return {
    admit(agentId, state) {
      const now = opts.clock.now();
      const seen = agents.get(agentId);
      if (seen !== undefined && seen.last === state) return 'drop_duplicate';
      const times = (seen?.times ?? []).filter((t) => now - t < GATE_WINDOW_MS);
      if (times.length >= GATE_CHANGES_PER_WINDOW) {
        if (seen !== undefined) seen.times = times;
        return 'drop_rate';
      }
      times.push(now);
      agents.delete(agentId);
      agents.set(agentId, { last: state, times });
      if (agents.size > GATE_MAX_AGENTS) {
        const oldest = agents.keys().next().value;
        if (oldest !== undefined) agents.delete(oldest);
      }
      return 'send';
    },
  };
}
