/**
 * Agent state validation (B058, CT-STATE-MAP, CT-WS-SESSION-EVENTS `agent.state`): a pure check of
 * a state name against the contract's state map and the wire/client-local split.
 *
 * - `accepted`: an agent-level state (`AGENT_WIRE_STATES`).
 * - `client_local`: a state of the map that only clients derive (`CLIENT_LOCAL_STATES`); a backend
 *   emitter never sends one as agent state (it uses `sys.notice` for limits).
 * - `unknown`: not in the map, or a map key not classified yet (a newer peer's state). CT-STATE-MAP
 *   rule 1: receivers tolerate it.
 *
 * No I/O and no state: two set lookups.
 *
 * `agentStateCheck` is the relay's policy over it, installed on B057's registry by the agents
 * module. CT-STATE-MAP: "The relay validates `agent.state.state` against **all** keys of
 * `state-map.json` (tolerant); clients emit only the list above". So the relay forwards every
 * well-formed name (B057 refuses a malformed one): an unknown one is logged at debug and counted
 * (`relay_agent_state_unknown_total`); a client-local one is the client's mistake, not the relay's
 * to refuse.
 *
 * Owns: the verdict and that policy. Must not: hold state or do I/O beyond the log and counter.
 */
import type { Logger, Metrics } from '@centcom/core';
import { AGENT_WIRE_STATES, CLIENT_LOCAL_STATES } from './wire-split.js';

/** What a state name is. */
export type StateVerdict = 'accepted' | 'client_local' | 'unknown';

/** The verdict on `state`. */
export function validateAgentState(state: string): { verdict: StateVerdict } {
  if (AGENT_WIRE_STATES.has(state)) return { verdict: 'accepted' };
  if (CLIENT_LOCAL_STATES.has(state)) return { verdict: 'client_local' };
  return { verdict: 'unknown' };
}

/** The relay's check for B057's `setStateValidator`: true when the state may be forwarded. */
export function agentStateCheck(deps: {
  metrics: Pick<Metrics, 'counter'>;
  logger?: Pick<Logger, 'debug'>;
}): (state: string) => boolean {
  return (state) => {
    if (validateAgentState(state).verdict === 'unknown') {
      deps.metrics.counter('relay_agent_state_unknown_total').inc();
      deps.logger?.debug({ kind: 'agent.state' }, 'agents.state_unknown');
    }
    return true;
  };
}
