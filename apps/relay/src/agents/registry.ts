/**
 * The agent registry (B057, CT-WS-SESSION-EVENTS `agent.spawn`, `agent.state`, `agent.exit`): the
 * relay's authoritative list of each session's agents (id, owner, mode, state, since, how it
 * ended), built from the cleartext `p` of the frames it lets through, so late joiners and the
 * spawn limit never depend on a client replaying them.
 *
 * Each frame is handled under the session's lock (`AgentStore.withSession`: Redis, so every node
 * agrees), checked, sequenced (the rest of the pipeline), and only then recorded:
 *
 * - **Who** (card scope): the mode is the session's (`SessionModePort`; every session is a
 *   command post until sessions store a mode). In a `command_post` session only the host may
 *   spawn, update or end agents. In a `branch` session the owner (or the host) may: an editor may
 *   spawn only with `owner` equal to their own member id (the server-stamped `from`), and send
 *   `agent.state` and `agent.exit` only for an agent they own. Anyone else: `sys.error forbidden`.
 *   A spawn whose `p.mode` is not the session's is `invalid_frame`.
 * - **Spawn:** refused with `forbidden` (quota detail) when the session already runs
 *   `max_parallel_agents` (CT-ENTITLEMENTS, relay checks spawn), and with `service_unavailable`
 *   while Redis is down (the limit fails closed). A resend of the same spawn frame by the member
 *   who sent it, with the same owner and mode, is sequenced again (B041 echoes its first seq) and
 *   changes nothing; any other spawn of a known agent id is `invalid_frame` and is not sequenced.
 * - **State:** an unknown agent is `invalid_frame`; an exited one is ignored (counted). A state
 *   B058's validator refuses is `invalid_frame`. Repeating the current state, or more than 2 per
 *   second per agent, is dropped before sequencing and counted, never answered or audited.
 * - **Exit:** marks the agent exited (outcome, error code), so it no longer counts against the
 *   limit; later frames for it never bring it back.
 * - Frames are tolerated input: an unknown field is ignored, a malformed `p` is `invalid_frame`;
 *   the connection is never closed here.
 *
 * `list`, `get` and `countLive` answer from this node's view (refreshed by every frame handled
 * here and by `snapshot`); `snapshot(sid)` reads the shared store.
 *
 * Owns: these rules and the node's view. Must not: read `ct`, or log anything but ids, kinds and
 * counts.
 */
import { isId, validateEvent } from '@centcom/contracts';
import { noopMetrics, type Logger, type Metrics } from '@centcom/core';
import type {
  AgentFrame,
  AgentMode,
  AgentOutcome,
  AgentRecord,
  AgentResult,
  AgentSender,
  AgentStore,
  DropReason,
  EntitlementsPort,
  SequenceStep,
  SessionModePort,
  StateValidator,
  StoredAgent,
} from './ports.js';
import { commandPostSessions } from './ports.js';
import type { StateRateLimiter } from './state-rate-limit.js';

/** The details of refusals (GUIDELINES §3.4). */
export const AGENT_DETAILS = Object.freeze({
  hostOnly: 'Only the host may control agents in a command-post session.',
  wrongMode: "The agent mode is not the session's mode.",
  ownerOnly: 'Only the agent owner or the host may control this agent.',
  spoofedOwner: 'An agent you spawn must be owned by you.',
  limit: 'The session already runs as many agents as its plan allows (max_parallel_agents).',
  unknownAgent: 'There is no such agent in this session.',
  duplicateAgent: 'An agent with this id already exists in this session.',
  malformed: 'The frame does not carry a valid agent payload.',
  badState: 'The agent state is not a known state name.',
  unavailable: 'Agents cannot be started right now; try again shortly.',
} as const);

/** What the registry needs. */
export interface AgentRegistryDeps {
  store: AgentStore;
  entitlements: EntitlementsPort;
  rateLimit: StateRateLimiter;
  /** The session's mode; default: every session is a command post. */
  sessions?: SessionModePort;
  /** B058's state-name check; default: any non-empty name. */
  validateState?: StateValidator;
  logger?: Logger;
  metrics?: Metrics;
}

const MODES: readonly string[] = ['command_post', 'branch'];
const OUTCOMES: readonly string[] = ['ok', 'error', 'canceled'];
const MAX_TEXT = 64;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const shortText = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= MAX_TEXT;
/** A product state name's shape (CT-STATE-MAP: kebab-case), known or not. */
const isStateName = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= MAX_TEXT && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(v);
const isTime = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));

/** The public record of a stored agent. */
export const recordOf = (a: StoredAgent): AgentRecord => ({
  agentId: a.agentId,
  owner: a.owner,
  mode: a.mode,
  state: a.state,
  since: a.since,
  ...(a.exited === undefined ? {} : { exited: { ...a.exited } }),
});

/**
 * The frame's cleartext against its CT-WS-SESSION-EVENTS schema (unknown fields tolerated). The
 * state name of `agent.state` is the state validator's (B058): an unknown name is tolerated input
 * (CT-STATE-MAP rule 1), so the schema check sees a known one in its place.
 */
const fitsContract = (frame: AgentFrame): boolean => {
  const p =
    frame.k === 'agent.state' && isRecord(frame.p) && isStateName(frame.p['state'])
      ? { ...frame.p, state: 'idle' }
      : frame.p;
  return validateEvent(frame.k, p, { mode: 'tolerant' }).ok;
};

const refuse = (
  code: 'forbidden' | 'invalid_frame' | 'service_unavailable',
  detail: string,
): AgentResult => ({ outcome: 'refused', code, detail });

/** Who may act on an existing agent: host always; in branch mode its owner too. */
function mayControl(
  agent: Pick<StoredAgent, 'mode' | 'owner'>,
  sender: AgentSender,
): AgentResult | null {
  if (sender.role === 'host') return null;
  if (agent.mode === 'command_post') return refuse('forbidden', AGENT_DETAILS.hostOnly);
  return agent.owner === sender.memberId ? null : refuse('forbidden', AGENT_DETAILS.ownerOnly);
}

/** The relay's agents per session. */
export class AgentRegistry {
  readonly #views = new Map<string, Map<string, StoredAgent>>();
  readonly #metrics: Metrics;
  readonly #sessions: SessionModePort;
  #validate: StateValidator;

  constructor(private readonly deps: AgentRegistryDeps) {
    this.#metrics = deps.metrics ?? noopMetrics;
    this.#sessions = deps.sessions ?? commandPostSessions;
    this.#validate = deps.validateState ?? ((state) => state.length > 0);
  }

  #drop(reason: DropReason): AgentResult {
    this.#metrics.counter('relay_agent_state_dropped_total', { reason }).inc();
    return { outcome: 'dropped', reason };
  }

  #remember(sid: string, agents: ReadonlyMap<string, StoredAgent>): void {
    this.#views.set(sid, new Map([...agents].map(([id, a]) => [id, { ...a }])));
  }

  /** Replaces the state-name check (B058 injects the state map's). */
  setStateValidator(validate: StateValidator): void {
    this.#validate = validate;
  }

  /** `agent.spawn` from `sender`. */
  onSpawn(
    sid: string,
    frame: AgentFrame,
    sender: AgentSender,
    sequence: SequenceStep,
  ): Promise<AgentResult> {
    const p = frame.p;
    if (
      !fitsContract(frame) ||
      !isRecord(p) ||
      !isId('agt', p['agent_id']) ||
      !isId('mem', p['owner']) ||
      typeof p['mode'] !== 'string' ||
      !MODES.includes(p['mode'])
    ) {
      return Promise.resolve(refuse('invalid_frame', AGENT_DETAILS.malformed));
    }
    const agentId = p['agent_id'] as string;
    const owner = p['owner'] as string;
    const mode = p['mode'] as AgentMode;
    return this.deps.store.withSession(sid, async (tx) => {
      const sessionMode = await this.#sessions.modeOf(sid);
      if (sender.role !== 'host' && sessionMode === 'command_post') {
        return refuse('forbidden', AGENT_DETAILS.hostOnly);
      }
      const agents = await tx.load();
      this.#remember(sid, agents);
      const existing = agents.get(agentId);
      if (existing !== undefined) {
        // Only the sender's own resend, unchanged, is one (B041 de-duplicates per sender).
        const resend =
          existing.spawnFrameId === frame.id &&
          existing.spawnedBy === sender.memberId &&
          existing.owner === owner &&
          existing.mode === mode;
        if (!resend) return refuse('invalid_frame', AGENT_DETAILS.duplicateAgent);
        await sequence();
        return { outcome: 'resent' };
      }
      if (sender.role !== 'host' && owner !== sender.memberId) {
        return refuse('forbidden', AGENT_DETAILS.spoofedOwner);
      }
      if (mode !== sessionMode) return refuse('invalid_frame', AGENT_DETAILS.wrongMode);
      if (tx.degraded) return refuse('service_unavailable', AGENT_DETAILS.unavailable);
      let max: number | null;
      try {
        max = await this.deps.entitlements.maxParallelAgents(sid);
      } catch (err) {
        this.deps.logger?.warn(
          { sid, error: err instanceof Error ? err.name : 'unknown' },
          'agents.entitlements_failed',
        );
        return refuse('service_unavailable', AGENT_DETAILS.unavailable);
      }
      const live = [...agents.values()].filter((a) => a.exited === undefined).length;
      if (max !== null && live >= max) {
        this.#metrics.counter('relay_agent_spawns_refused_total', { reason: 'limit' }).inc();
        return refuse('forbidden', AGENT_DETAILS.limit);
      }
      const stored = await sequence();
      if (stored === undefined) return { outcome: 'unsequenced' };
      const agent: StoredAgent = {
        agentId,
        owner,
        mode,
        // agent.spawn carries no state: none until the first agent.state.
        state: '',
        since: stored.ts,
        spawnedSeq: stored.seq,
        spawnFrameId: frame.id,
        spawnedBy: sender.memberId,
      };
      agents.set(agentId, agent);
      await this.#save(sid, tx, agents, agentId);
      return { outcome: 'sequenced', seq: stored.seq };
    });
  }

  /** `agent.state` from `sender`. */
  onState(
    sid: string,
    frame: AgentFrame,
    sender: AgentSender,
    sequence: SequenceStep,
  ): Promise<AgentResult> {
    const p = frame.p;
    if (
      !fitsContract(frame) ||
      !isRecord(p) ||
      !isId('agt', p['agent_id']) ||
      !isStateName(p['state']) ||
      !isTime(p['since'])
    ) {
      return Promise.resolve(refuse('invalid_frame', AGENT_DETAILS.malformed));
    }
    const agentId = p['agent_id'] as string;
    const state = p['state'] as string;
    const since = p['since'] as string;
    return this.deps.store.withSession(sid, async (tx) => {
      if (sender.role !== 'host' && (await this.#sessions.modeOf(sid)) === 'command_post') {
        return refuse('forbidden', AGENT_DETAILS.hostOnly);
      }
      const agents = await tx.load();
      this.#remember(sid, agents);
      const agent = agents.get(agentId);
      if (agent === undefined) return refuse('invalid_frame', AGENT_DETAILS.unknownAgent);
      if (agent.exited !== undefined) return this.#drop('exited');
      const denied = mayControl(agent, sender);
      if (denied !== null) return denied;
      if (!this.#validate(state)) return refuse('invalid_frame', AGENT_DETAILS.badState);
      if (agent.state === state) return this.#drop('identical');
      if (!(await this.deps.rateLimit.allow(sid, agentId))) return this.#drop('rate');
      const stored = await sequence();
      if (stored === undefined) return { outcome: 'unsequenced' };
      agents.set(agentId, { ...agent, state, since });
      await this.#save(sid, tx, agents, agentId);
      return { outcome: 'sequenced', seq: stored.seq };
    });
  }

  /** `agent.exit` from `sender`. */
  onExit(
    sid: string,
    frame: AgentFrame,
    sender: AgentSender,
    sequence: SequenceStep,
  ): Promise<AgentResult> {
    const p = frame.p;
    if (
      !fitsContract(frame) ||
      !isRecord(p) ||
      !isId('agt', p['agent_id']) ||
      typeof p['outcome'] !== 'string' ||
      !OUTCOMES.includes(p['outcome']) ||
      (p['error_code'] !== undefined && !shortText(p['error_code']))
    ) {
      return Promise.resolve(refuse('invalid_frame', AGENT_DETAILS.malformed));
    }
    const agentId = p['agent_id'] as string;
    const outcome = p['outcome'] as AgentOutcome;
    const errorCode = p['error_code'] as string | undefined;
    return this.deps.store.withSession(sid, async (tx) => {
      if (sender.role !== 'host' && (await this.#sessions.modeOf(sid)) === 'command_post') {
        return refuse('forbidden', AGENT_DETAILS.hostOnly);
      }
      const agents = await tx.load();
      this.#remember(sid, agents);
      const agent = agents.get(agentId);
      if (agent === undefined) return refuse('invalid_frame', AGENT_DETAILS.unknownAgent);
      if (agent.exited !== undefined) return this.#drop('exited');
      const denied = mayControl(agent, sender);
      if (denied !== null) return denied;
      const stored = await sequence();
      if (stored === undefined) return { outcome: 'unsequenced' };
      agents.set(agentId, {
        ...agent,
        exited: { outcome, ...(errorCode === undefined ? {} : { errorCode }) },
        exitedSeq: stored.seq,
      });
      await this.#save(sid, tx, agents, agentId);
      return { outcome: 'sequenced', seq: stored.seq };
    });
  }

  /** Saves after a sequenced change; the frame went out, so a failed save is logged, not thrown. */
  async #save(
    sid: string,
    tx: { save(a: ReadonlyMap<string, StoredAgent>, c: readonly string[]): Promise<void> },
    agents: Map<string, StoredAgent>,
    agentId: string,
  ): Promise<void> {
    this.#remember(sid, agents);
    try {
      await tx.save(agents, [agentId]);
    } catch (err) {
      this.#metrics.counter('relay_agent_store_failures_total').inc();
      this.deps.logger?.warn(
        { sid, error: err instanceof Error ? err.name : 'unknown' },
        'agents.save_failed',
      );
    }
  }

  /** The session's agents on this node's view, spawn order. */
  list(sid: string): AgentRecord[] {
    return [...(this.#views.get(sid)?.values() ?? [])]
      .sort((a, b) => a.spawnedSeq - b.spawnedSeq)
      .map(recordOf);
  }

  /** One agent on this node's view. */
  get(sid: string, agentId: string): AgentRecord | undefined {
    const a = this.#views.get(sid)?.get(agentId);
    return a === undefined ? undefined : recordOf(a);
  }

  /** Agents not exited on this node's view. */
  countLive(sid: string): number {
    return [...(this.#views.get(sid)?.values() ?? [])].filter((a) => a.exited === undefined).length;
  }

  /** Live agents by mode across this node's sessions (the `relay_agents_live{mode}` gauge). */
  liveByMode(): Record<AgentMode, number> {
    const out: Record<AgentMode, number> = { command_post: 0, branch: 0 };
    for (const view of this.#views.values()) {
      for (const a of view.values()) if (a.exited === undefined) out[a.mode] += 1;
    }
    return out;
  }

  /** The session's agents from the shared store (roster and join flows); refreshes the view. */
  async snapshot(sid: string): Promise<AgentRecord[]> {
    this.#remember(sid, await this.deps.store.read(sid));
    return this.list(sid);
  }

  /** Forgets a session's view (its room closed on this node). */
  forget(sid: string): void {
    this.#views.delete(sid);
  }
}
