/**
 * `conflict.detected` (B061, CT-WS-SESSION-EVENTS): two agents touch the same file, or a merge
 * conflicts. The relay sees agent ids and path hashes only (`p.agent_ids`, `p.path_hmacs`); the
 * paths stay in `ct`.
 *
 * - **From a member** (`onConflictDetected`): host only in a `command_post` session (`editor*`),
 *   any editor in a `branch` session. `p` must match the schema (at most 200 of each); every agent
 *   must be one the session knows (not exited), owned by a member connected now (else
 *   `invalid_frame`: the
 *   relay cannot drop part of a signed frame), and every path hash of the lock store's hash shape
 *   (B059: at most 64 characters). Not whether a lock is held on it: a merge conflict
 *   (CT-WS-SESSION-EVENTS) can name files never locked, and B059's lock keys go on release and
 *   expiry. An identical signal (same agents, same paths, in any order) within
 *   30 s is one: a later one is refused `conflict`; the same frame sent again is acked again.
 * - **From the server** (`onLockDenied`, B059's lock denials): one `conflict.detected` with the
 *   holder's and the requester's agent ids and the one path hash, from `srv`, `p` only (no `ct`):
 *   once per pair of agents per 30 s, and at most 10 per session per second (the rest counted and
 *   dropped). Agents the session does not know, or whose owner is not connected, are dropped, and
 *   a signal left with fewer than two agents is not sent.
 * - Registry or Redis down: a member's signal is refused `service_unavailable`; a server signal is
 *   dropped (counted). Nothing here holds any other frame.
 *
 * Keys hold a hash of the agent and path sets, never the path hashes themselves.
 *
 * Owns: conflict signals. Must not: read `ct`, put anything but agent ids and path hashes in a
 * signal, or block any other frame.
 */
import { createHash } from 'node:crypto';
import { isId, validateEvent } from '@centcom/contracts';
import { noopMetrics, type Logger, type Metrics } from '@centcom/core';
import { maySignal } from './branch-handler.js';
import {
  CONFLICT_DEDUPE_MS,
  MAX_CONFLICT_ITEMS,
  PATH_HMAC,
  type AgentDirectoryPort,
  type ConflictEmitter,
  type ConnectedPort,
  type ModePort,
  type SignalContext,
  type SignalFrame,
  type SignalGate,
  type SignalResult,
} from './ports.js';

/** What the signal needs. */
export interface ConflictSignalDeps {
  agents: AgentDirectoryPort;
  connected: ConnectedPort;
  modes: ModePort;
  gate: SignalGate;
  emitter: ConflictEmitter;
  logger?: Logger;
  metrics?: Metrics;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A short, order-free hash of a set of ids (never the ids in a key). */
const setHash = (...parts: readonly string[][]): string =>
  createHash('sha256')
    .update(parts.map((ids) => [...new Set(ids)].sort().join(',')).join('|'))
    .digest('base64url')
    .slice(0, 22);

/** A member's signal that passed its checks: its 30 s window, and whether this frame marked it. */
interface Checked {
  key: string;
  mine: string;
  marked: boolean;
}

const refused = (code: 'invalid_frame' | 'forbidden' | 'conflict', detail: string) =>
  ({ outcome: 'refused', code, detail }) as const;

/** Handles `conflict.detected` from members and from lock denials. */
export class ConflictSignal {
  readonly #metrics: Metrics;

  constructor(private readonly deps: ConflictSignalDeps) {
    this.#metrics = deps.metrics ?? noopMetrics;
  }

  async onConflictDetected(ctx: SignalContext, frame: SignalFrame): Promise<SignalResult> {
    let checked: Checked | SignalResult;
    try {
      checked = await this.#check(ctx, frame);
    } catch (err) {
      // The registry, the connected markers or the gate could not be read (before sequencing).
      this.deps.logger?.warn(
        { sid: ctx.sid, error: err instanceof Error ? err.name : 'unknown' },
        'branches.conflict_failed',
      );
      return {
        outcome: 'refused',
        code: 'service_unavailable',
        detail: 'Conflicts cannot be checked right now; try again shortly.',
      };
    }
    if ('outcome' in checked) return checked;
    const { key, mine, marked } = checked;
    // A resend of the frame that marked it goes on: the sequencer acks it again.
    const stored = await ctx.sequence();
    if (stored === undefined || stored === 'unknown') {
      // Refused before the store: free the window. Unknown: it may be in the log, keep it.
      if (stored === undefined && marked) {
        await this.deps.gate.unmark(key, mine).catch(() => undefined);
      }
      return { outcome: 'ignored' };
    }
    // Sequenced now (a resend of a stored frame comes back undefined, so this counts each once).
    this.#metrics.counter('relay_conflicts_signalled_total', { source: 'client' }).inc();
    return { outcome: 'sequenced' };
  }

  /** A member's signal checked and its 30 s window marked, or why not. */
  async #check(ctx: SignalContext, frame: SignalFrame): Promise<Checked | SignalResult> {
    const sid = ctx.sid;
    if (!(await maySignal(this.deps.modes, sid, ctx.sender))) {
      return refused('forbidden', 'Only the host signals conflicts in this session.');
    }
    const p = frame.p;
    if (
      !validateEvent('conflict.detected', p, { mode: 'tolerant' }).ok ||
      !isRecord(p) ||
      !Array.isArray(p['agent_ids']) ||
      !Array.isArray(p['path_hmacs']) ||
      p['agent_ids'].length > MAX_CONFLICT_ITEMS ||
      p['path_hmacs'].length > MAX_CONFLICT_ITEMS ||
      !p['agent_ids'].every((a) => isId('agt', a)) ||
      !p['path_hmacs'].every((h) => typeof h === 'string' && PATH_HMAC.test(h))
    ) {
      return refused('invalid_frame', 'The conflict signal is malformed.');
    }
    const agentIds = p['agent_ids'] as string[];
    const pathHmacs = p['path_hmacs'] as string[];
    if (!(await this.#allEligible(sid, agentIds))) {
      return refused(
        'invalid_frame',
        'A conflict may name only agents of this session owned by connected members.',
      );
    }
    const key = `conflict:${sid}:${setHash(agentIds, pathHmacs)}`;
    const mine = `${ctx.sender.memberId}/${frame.id}`;
    const marked = await this.deps.gate.mark(key, mine, CONFLICT_DEDUPE_MS);
    if (marked !== true && marked !== mine) {
      this.#metrics.counter('relay_conflict_signals_dropped_total', { reason: 'duplicate' }).inc();
      return refused('conflict', 'The same conflict was signalled in the last 30 seconds.');
    }
    return { key, mine, marked: marked === true };
  }

  /** Whether every agent is the session's and owned by a member connected now. */
  async #allEligible(sid: string, agentIds: readonly string[]): Promise<boolean> {
    const eligible = await this.#eligible(sid, agentIds);
    return agentIds.every((a) => eligible.has(a));
  }

  /** Those of `agentIds` the session knows, owned by a connected member. */
  async #eligible(sid: string, agentIds: readonly string[]): Promise<Set<string>> {
    // Agents that exited are no longer present.
    const owners = new Map(
      (await this.deps.agents.agents(sid))
        .filter((a) => !a.exited)
        .map((a) => [a.agentId, a.owner] as const),
    );
    const out = new Set<string>();
    const online = new Map<string, boolean>();
    for (const agent of new Set(agentIds)) {
      const owner = owners.get(agent);
      if (owner === undefined) continue;
      let on = online.get(owner);
      if (on === undefined) {
        on = await this.deps.connected.isConnected(sid, owner);
        online.set(owner, on);
      }
      if (on) out.add(agent);
    }
    return out;
  }

  /**
   * A lock on `pathHmac` held by `holderAgent` was denied to `requesterAgent`: signals it from the
   * server (deduped, rate-capped). Never throws.
   */
  async onLockDenied(
    sid: string,
    d: { requesterAgent: string; holderAgent: string; pathHmac: string },
  ): Promise<void> {
    const drop = (reason: string) =>
      this.#metrics.counter('relay_conflict_signals_dropped_total', { reason }).inc();
    try {
      if (d.holderAgent === d.requesterAgent || !PATH_HMAC.test(d.pathHmac)) return;
      const agents = [d.holderAgent, d.requesterAgent];
      // The window first (one Redis call): a burst of the same pair costs no registry reads.
      const key = `conflict:${sid}:pair:${setHash(agents)}`;
      if ((await this.deps.gate.mark(key, 'srv', CONFLICT_DEDUPE_MS)) !== true) {
        drop('duplicate');
        return;
      }
      let eligible: Set<string>;
      try {
        eligible = await this.#eligible(sid, agents);
      } catch (err) {
        await this.deps.gate.unmark(key, 'srv').catch(() => undefined);
        throw err;
      }
      if (!agents.every((a) => eligible.has(a))) {
        await this.deps.gate.unmark(key, 'srv').catch(() => undefined);
        drop('ineligible');
        return;
      }
      if (!(await this.deps.gate.take(sid))) {
        // Not signalled: the next denial of the pair may be.
        await this.deps.gate.unmark(key, 'srv').catch(() => undefined);
        drop('rate');
        return;
      }
      // A failed emit keeps the window: the frame may have been stored before the failure.
      await this.deps.emitter.emit(sid, { agent_ids: agents, path_hmacs: [d.pathHmac] });
      this.#metrics.counter('relay_conflicts_signalled_total', { source: 'server' }).inc();
    } catch (err) {
      drop('unavailable');
      this.deps.logger?.warn(
        { sid, error: err instanceof Error ? err.name : 'unknown' },
        'branches.conflict_failed',
      );
    }
  }
}
