/**
 * Which product states travel as agent state (B058, CT-STATE-MAP).
 *
 * The state names themselves come from the contract (`PRODUCT_STATES`, generated from
 * `contracts/state-map.json`). The split is reconciled here, in one place, with
 * `contracts/09-state-map.md`, section "Agent-level states (what a client emits in `agent.state`)":
 *
 * - AGENT_LEVEL: its list "`idle`, `ready`, `thinking`, ... `merge-conflict`, `deploying`,
 *   `saving`".
 * - CLIENT_LOCAL: its sentence "All other keys (connectivity, account, provider (`provider-*`),
 *   limits, social, lifecycle such as `first-run`, `empty`, `celebrate`, `ci-*`, `pr-*`,
 *   `listening`, `prompt-received`, `host-session`) are client-local UI states", with the members
 *   of those categories as its "Categories" paragraph names them, patterns kept as patterns.
 *   `sleeping` and `away` sit in the idle category but not in the agent-level list, so they are
 *   client-local ("all other keys").
 *
 * `state.classification.test.ts` parses that section and fails when AGENT_LEVEL differs from its
 * list, when a name of its client-local sentence is not classified local, and when any key of the
 * map is in neither (or both) sets. A key the contract adds before it is classified here is
 * `unknown` at runtime: forwarded and counted, never refused.
 *
 * Owns: the split. Must not: add, rename or map states, or read the animation values.
 */
import { PRODUCT_STATES } from '@centcom/contracts';

/** The agent-level states, as `09-state-map.md` "Agent-level states" lists them. */
const AGENT_LEVEL = [
  'idle',
  'ready',
  'thinking',
  'thinking-hard',
  'planning',
  'searching',
  'reading-file',
  'editing-file',
  'creating-file',
  'deleting-file',
  'running-command',
  'tool-running',
  'streaming',
  'compacting',
  'background-task',
  'sub-agent',
  'awaiting-approval',
  'asking-question',
  'approved',
  'denied',
  'success',
  'error',
  'crash',
  'warning',
  'tests-pass',
  'tests-fail',
  'merge-conflict',
  'deploying',
  'saving',
] as const;

/**
 * The client-local states, by the same section's categories: connectivity and account, provider,
 * limits, social, lifecycle, and the idle states outside the agent-level list. A trailing `*` is
 * the contract's own pattern (`ci-*`, `pr-*`, `provider-*`, `teammate-*`).
 */
const CLIENT_LOCAL = [
  // connectivity / account
  'offline',
  'reconnecting',
  'online',
  'auth-required',
  'session-expired',
  // provider
  'provider-*',
  // limits
  'rate-limited',
  'quota-reached',
  'cost-alert',
  'context-full',
  // social
  'host-session',
  'teammate-*',
  'message-queued',
  'handoff',
  'pair-working',
  'high-five',
  'welcome-teammate',
  // lifecycle and the rest the section names
  'first-run',
  'empty',
  'no-results',
  'update-available',
  'celebrate',
  'ci-*',
  'pr-*',
  'listening',
  'prompt-received',
  // idle category, not agent-level
  'sleeping',
  'away',
] as const;

/** Thrown at load when the split does not fit the contract's state map (the relay does not start). */
export class StateMapError extends Error {
  override name = 'StateMapError';
}

/** True when `name` matches one of `patterns` (a name, or a prefix ending in `*`). */
export const matchesAny = (name: string, patterns: readonly string[]): boolean =>
  patterns.some((p) => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : name === p));

/**
 * The split of `keys`: agent-level, client-local, and the keys in neither (unclassified). Throws
 * when the agent-level list names a state the map lacks, or a key is in both.
 */
export function splitStates(
  keys: readonly string[],
  agentLevel: readonly string[] = AGENT_LEVEL,
  clientLocal: readonly string[] = CLIENT_LOCAL,
): { wire: ReadonlySet<string>; local: ReadonlySet<string>; unclassified: ReadonlySet<string> } {
  if (keys.length === 0) throw new StateMapError('the contract state map has no states');
  const known = new Set(keys);
  const missing = agentLevel.filter((s) => !known.has(s));
  if (missing.length > 0) {
    throw new StateMapError(`agent-level states missing from the state map: ${missing.join(', ')}`);
  }
  const wire = new Set(agentLevel);
  const both = keys.filter((k) => wire.has(k) && matchesAny(k, clientLocal));
  if (both.length > 0) {
    throw new StateMapError(`states classified both ways: ${both.join(', ')}`);
  }
  const local = new Set(keys.filter((k) => !wire.has(k) && matchesAny(k, clientLocal)));
  const unclassified = new Set(keys.filter((k) => !wire.has(k) && !local.has(k)));
  return { wire, local, unclassified };
}

const split = splitStates(PRODUCT_STATES);

/** States a client sends as `agent.state` (the agent-level list, checked against the map). */
export const AGENT_WIRE_STATES: ReadonlySet<string> = split.wire;
/** States of the map that only clients derive (the client-local classification). */
export const CLIENT_LOCAL_STATES: ReadonlySet<string> = split.local;
/** Keys of the map in neither set (a contract addition not classified yet): treated as unknown. */
export const UNCLASSIFIED_STATES: ReadonlySet<string> = split.unclassified;

/** The client-local names and patterns, for the reconciliation test. */
export const CLIENT_LOCAL_PATTERNS: readonly string[] = CLIENT_LOCAL;
