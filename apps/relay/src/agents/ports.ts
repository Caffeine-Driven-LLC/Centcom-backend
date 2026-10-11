/**
 * The agent registry's ports (B057, CT-WS-SESSION-EVENTS `agent.*`): the records, and what the
 * registry needs from the rest of the relay, so it runs against fakes in tests and against Redis,
 * Postgres, B041's sequencing and the plan's limits in the relay.
 *
 * - `AgentStore`: a session's agents, serialised per session across nodes (`withSession`).
 * - `EntitlementsPort`: the session's `max_parallel_agents` (CT-ENTITLEMENTS), cached.
 * - `StateValidator`: whether a state name is allowed (B058 injects the state map's check).
 *
 * Owns: the shapes. Must not: describe anything from `ct` (label, branch, worktree, model).
 */
import type { SessionRole } from '../rooms/kind-policy.js';
import type { StoredFrame } from '../seq/types.js';

/** How an agent is run (CT-WS-SESSION-EVENTS `agent.spawn.p.mode`). */
export type AgentMode = 'command_post' | 'branch';

/** How an agent ended (`agent.exit.p.outcome`). */
export type AgentOutcome = 'ok' | 'error' | 'canceled';

/** The registry's view of one agent (the card's interface). */
export interface AgentRecord {
  agentId: string;
  /** The owning member (`mem_`). */
  owner: string;
  mode: AgentMode;
  /** The latest accepted state name; '' until the first `agent.state`. */
  state: string;
  /** When that state began (the frame's `since`). */
  since: string;
  exited?: { outcome: AgentOutcome; errorCode?: string };
}

/** A record as stored: the record and the frames that made it. */
export interface StoredAgent extends AgentRecord {
  spawnedSeq: number;
  /** The `msg_` id of the spawn frame, so a resend of it is recognised. */
  spawnFrameId: string;
  /** The member who sent the spawn (only their resend is one). */
  spawnedBy: string;
  exitedSeq?: number;
}

/** A session's agents, under the session's lock. */
export interface AgentTx {
  /** Every agent the session ever had, by id. */
  load(): Promise<Map<string, StoredAgent>>;
  /** Stores `agents` (Redis) and writes the `changed` ones through to Postgres. */
  save(agents: ReadonlyMap<string, StoredAgent>, changed: readonly string[]): Promise<void>;
  /**
   * True when Redis could not be reached: the agents came from Postgres and no cross-node lock
   * is held, so new spawns are refused (fail closed for the limit).
   */
  readonly degraded: boolean;
}

/** Where agents are kept. */
export interface AgentStore {
  /** Runs `fn` holding session `sid`'s lock (or degraded, see AgentTx). */
  withSession<T>(sid: string, fn: (tx: AgentTx) => Promise<T>): Promise<T>;
  /** The session's agents without the lock (reads for `snapshot`). */
  read(sid: string): Promise<Map<string, StoredAgent>>;
}

/**
 * The session's mode (CT-WS-ENVELOPE `welcome.p.session.mode`): `command_post` or `branch`. No
 * session stores one yet (every session is created command-post), so the relay's port answers
 * `command_post` until one does.
 */
export interface SessionModePort {
  modeOf(sid: string): Promise<AgentMode>;
}

/** Every session is a command post until sessions store a mode. */
export const commandPostSessions: SessionModePort = Object.freeze({
  modeOf: () => Promise.resolve('command_post' as const),
});

/** The session's plan limit on agents running at once (null: no limit). */
export interface EntitlementsPort {
  maxParallelAgents(sid: string): Promise<number | null>;
}

/** Whether a state name is allowed (B058's state map check; until then, any name). */
export type StateValidator = (state: string) => boolean;

/** The sender of a frame, as the relay knows it (never from the frame). */
export interface AgentSender {
  /** The member's `mem_` id: the frame's server-stamped `from`. */
  memberId: string;
  role: SessionRole;
}

/** A client's `agent.*` frame as the registry reads it: ids and the cleartext `p` only. */
export interface AgentFrame {
  id: string;
  k: 'agent.spawn' | 'agent.state' | 'agent.exit';
  p: unknown;
}

/** Sequences the frame (the rest of the pipeline); undefined when sequencing refused it. */
export type SequenceStep = () => Promise<StoredFrame | undefined>;

/** What became of a frame. */
export type AgentResult =
  | { outcome: 'sequenced'; seq: number }
  | { outcome: 'resent' }
  | { outcome: 'dropped'; reason: DropReason }
  | {
      outcome: 'refused';
      code: 'forbidden' | 'invalid_frame' | 'service_unavailable';
      detail: string;
    }
  | { outcome: 'unsequenced' };

/** Why a frame was dropped without an answer (`relay_agent_state_dropped_total{reason}`). */
export type DropReason = 'rate' | 'identical' | 'exited';
