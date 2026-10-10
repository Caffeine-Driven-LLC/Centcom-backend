/**
 * The session lifecycle service (B053, CT-API-SESSIONS, CT-WS-CONTROL): owns session rows and
 * their state, so REST (B054), the relay and the worker agree on one state.
 *
 * - **create:** the name is checked (CT-IDS Text: 1-80 characters, NFC, no control characters)
 *   and so is the region. The entitlements come next (B080, at most 2 s; a timeout or an error is
 *   503 with `retry_after_s` 5, no row):
 *   - `relay_access` must be on;
 *   - the workspace's sessions that are not over (live, paused) must be under
 *     `max_concurrent_sessions`;
 *   - a refusal is 403 `entitlement_required`.
 *
 *   The session is written `live`, with `last_host_seen_at` = now (so the 10 min grace covers a
 *   host who never connects), its host member (slot 0), its policy defaults and a
 *   `session.created` outbox row.
 * - **end:** by the host, or a workspace owner or admin (anyone else: 403 `host_required`).
 *   Ending an ended or expired session returns it unchanged.
 * - **Host presence** (the relay calls these):
 *   - `onHostConnected`: records the host as connected, and a paused session goes back to live;
 *   - `onHostDisconnected`: records when the host was last seen;
 *   - `hostLoss`: the host-loss evaluator for the relay's failover (`host-loss.ts`).
 * - **sweep(now):**
 *   - pauses live sessions whose host has been gone 10 min, and expires sessions paused 24 h;
 *   - idempotent, and safe on several workers (`repository.sweep`'s advisory lock);
 *   - then retries undelivered notifications.
 * - **Notifications:** every transition writes an outbox row in its own transaction. After the
 *   commit (never before) it is delivered:
 *   - `control.session_state` to the relay, carrying the session's current state, so a late
 *     retry never sends an old state;
 *   - the `session.*` domain event when the transition has one (created, started, ended).
 *
 *   A failure stays in the outbox and is retried with backoff (5 s doubling, at most 10 min). The
 *   relay also reconciles on its next connection (the handshake reads the state).
 *
 * Every transition is a conditional UPDATE (`WHERE state IN (sources)`), so concurrent instances
 * never both win one. Rows are never deleted here.
 *
 * Owns: the rules above. Must not: read a plan name (only the entitlements port), delete a session
 * or its history, or notify before the commit.
 */
import { checkName, newId } from '@centcom/contracts';
import {
  AppError,
  noopMetrics,
  unavailable,
  validationFailed,
  type Logger,
  type Metrics,
  type Page,
  type SigningKeys,
} from '@centcom/core';
import { createHash } from 'node:crypto';
import {
  evaluateHostLoss,
  HOST_GRACE_MS,
  PAUSED_EXPIRY_MS,
  type ConnectedEditor,
  type HostLossDecision,
} from './host-loss.js';
import type {
  DomainEventsPort,
  EntitlementCheck,
  EntitlementsPort,
  RelayNotifierPort,
  Session,
  SessionPolicyDefaults,
} from './ports.js';
import type { ListQuery, OutboxRow, SessionRepository, StoredSession } from './repository.js';
import { isFinal, sourcesOf, transition, type SessionState } from './state-machine.js';

/** How long an entitlement check may take. */
export const ENTITLEMENTS_TIMEOUT_MS = 2_000;
/** `retry_after_s` when the entitlements could not be read. */
export const ENTITLEMENTS_RETRY_AFTER_S = 5;
/** The first outbox retry waits this long; each later one twice as long, at most OUTBOX_MAX_DELAY_MS. */
export const OUTBOX_BASE_DELAY_MS = 5_000;
export const OUTBOX_MAX_DELAY_MS = 10 * 60 * 1000;
/** Rows one sweep pauses and expires at most (each); the next sweep takes the rest. */
export const SWEEP_BATCH = 500;
/** Outbox rows one sweep delivers at most. */
export const OUTBOX_BATCH = 200;

/** The policy of a session without one (B051's defaults). */
export const DEFAULT_SESSION_POLICY: Readonly<SessionPolicyDefaults> = Object.freeze({
  auto_approve: 'ask',
  share_history: false,
  queue_limit: 20,
  locked: false,
  auto_failover: false,
});

const REGION = /^[a-z][a-z0-9-]{1,31}$/;

/** The details of the refusals (GUIDELINES §3.4). */
export const SESSION_DETAILS = Object.freeze({
  relayOff: 'Your plan does not include hosted sessions.',
  tooMany: 'Your workspace already has as many hosted sessions as its plan allows.',
  unavailable: 'Plan limits cannot be checked right now. Try again shortly.',
  notFound: 'That session does not exist.',
  hostOnly: 'Only the host or a workspace owner or admin can do that.',
  over: 'That session has ended.',
} as const);

/** What `create` takes. */
export interface CreateSessionInput {
  workspaceId: string;
  creatorUserId: string;
  /** The device the host connects from (the host's session member row needs one). */
  creatorDeviceId: string;
  /** The host's member id; a new one by default. */
  creatorMemberId?: string;
  name: string;
  region: string;
  policy?: Partial<SessionPolicyDefaults>;
}

/** Who acts. */
export interface Actor {
  userId: string;
}

/** What the service needs. */
export interface SessionServiceDeps {
  repository: SessionRepository;
  entitlements: EntitlementsPort;
  relay: RelayNotifierPort;
  events: DomainEventsPort;
  /** CT-PAGE cursor keys. */
  cursorKeys: SigningKeys;
  /** Milliseconds since the epoch. */
  clock?: () => number;
  entitlementsTimeoutMs?: number;
  logger?: Logger;
  metrics?: Metrics;
}

/** The API shape of a stored session. */
export function toSession(s: StoredSession): Session {
  return {
    id: s.row.id,
    workspace: s.row.workspace_id ?? '',
    name: s.row.name,
    state: s.row.state,
    host: s.row.host_member_id,
    policy: s.policy ?? { ...DEFAULT_SESSION_POLICY },
    region: s.row.region,
    created_at: s.row.created_at.toISOString(),
    ended_at: s.row.ended_at?.toISOString() ?? null,
  };
}

/** The session lifecycle. */
export class SessionService {
  readonly #deps: SessionServiceDeps;
  readonly #clock: () => number;
  readonly #metrics: Metrics;

  constructor(deps: SessionServiceDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? Date.now;
    this.#metrics = deps.metrics ?? noopMetrics;
  }

  get #repo(): SessionRepository {
    return this.#deps.repository;
  }

  /** B080's check, at most 2 s; 503 when it cannot answer. */
  async #check(
    workspaceId: string,
    key: 'relay_access' | 'max_concurrent_sessions',
    current?: number,
  ): Promise<EntitlementCheck> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.#deps.entitlements.check(workspaceId, key, current),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('entitlements timed out')),
            this.#deps.entitlementsTimeoutMs ?? ENTITLEMENTS_TIMEOUT_MS,
          );
          timer.unref();
        }),
      ]);
    } catch {
      throw unavailable(ENTITLEMENTS_RETRY_AFTER_S, SESSION_DETAILS.unavailable);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async create(input: CreateSessionInput): Promise<Session> {
    const name = checkName('sessionName', input.name);
    if (!name.ok) {
      throw validationFailed(
        name.errors.map((e) => ({ pointer: '/name', code: e.code, detail: e.detail })),
      );
    }
    if (!REGION.test(input.region)) {
      throw validationFailed([{ pointer: '/region', code: 'invalid', detail: 'is not a region' }]);
    }
    const relay = await this.#check(input.workspaceId, 'relay_access');
    if (!relay.allowed) {
      throw new AppError('entitlement_required', { detail: SESSION_DETAILS.relayOff });
    }
    const active = await this.#repo.countActive(input.workspaceId);
    const room = await this.#check(input.workspaceId, 'max_concurrent_sessions', active);
    if (!room.allowed) {
      throw new AppError('entitlement_required', { detail: SESSION_DETAILS.tooMany });
    }
    const at = new Date(this.#clock());
    const stored = await this.#repo.insert({
      id: newId('ses'),
      workspaceId: input.workspaceId,
      name: name.value,
      region: input.region,
      createdBy: input.creatorUserId,
      at,
      host: {
        id: input.creatorMemberId ?? newId('mem'),
        userId: input.creatorUserId,
        deviceId: input.creatorDeviceId,
      },
      ...(input.policy === undefined
        ? {}
        : { policy: { ...DEFAULT_SESSION_POLICY, ...input.policy } }),
    });
    this.#counted('live');
    await this.deliverOutbox(this.#clock(), stored.row.id);
    return toSession(stored);
  }

  async get(id: string): Promise<Session | null> {
    const stored = await this.#repo.get(id);
    return stored === null ? null : toSession(stored);
  }

  async list(q: ListQuery): Promise<Page<Session>> {
    const filterHash = createHash('sha256')
      .update(JSON.stringify([q.workspace ?? null, q.state ?? null, q.mineUserId ?? null]))
      .digest('base64url')
      .slice(0, 22);
    const result = await this.#repo.list(q, {
      keys: this.#deps.cursorKeys,
      now: this.#clock(),
      filterHash,
    });
    return { ...result, data: result.data.map(toSession) };
  }

  /** The session, or 404. */
  async #require(id: string): Promise<StoredSession> {
    const stored = await this.#repo.get(id);
    if (stored === null)
      throw new AppError('session_not_found', { detail: SESSION_DETAILS.notFound });
    return stored;
  }

  /** Whether `by` is the host of `s`, or an owner or admin of its workspace. */
  async #mayManage(s: StoredSession, by: Actor, adminsToo: boolean): Promise<boolean> {
    const member = await this.#repo.memberOf(s.row.id, by.userId);
    if (member !== null && member === s.row.host_member_id) return true;
    if (!adminsToo || s.row.workspace_id === null) return false;
    const role = await this.#repo.workspaceRole(s.row.workspace_id, by.userId);
    return role === 'owner' || role === 'admin';
  }

  async rename(id: string, name: string, by: Actor): Promise<Session> {
    const stored = await this.#require(id);
    if (!(await this.#mayManage(stored, by, false))) {
      throw new AppError('host_required', { detail: SESSION_DETAILS.hostOnly });
    }
    const checked = checkName('sessionName', name);
    if (!checked.ok) {
      throw validationFailed(
        checked.errors.map((e) => ({ pointer: '/name', code: e.code, detail: e.detail })),
      );
    }
    if (!(await this.#repo.rename(id, checked.value, new Date(this.#clock())))) {
      throw new AppError('session_ended', { detail: SESSION_DETAILS.over });
    }
    return toSession(await this.#require(id));
  }

  async setPolicyDefaults(
    id: string,
    policy: Partial<SessionPolicyDefaults>,
    by: Actor,
  ): Promise<Session> {
    const stored = await this.#require(id);
    if (!(await this.#mayManage(stored, by, false))) {
      throw new AppError('host_required', { detail: SESSION_DETAILS.hostOnly });
    }
    if (isFinal(stored.row.state))
      throw new AppError('session_ended', { detail: SESSION_DETAILS.over });
    await this.#repo.setPolicy(id, { ...(stored.policy ?? DEFAULT_SESSION_POLICY), ...policy });
    return toSession(await this.#require(id));
  }

  /** Ends the session (host, or workspace owner/admin); an ended or expired one is returned as is. */
  async end(id: string, by: Actor & { reason: 'done' | 'abandoned' | 'error' }): Promise<Session> {
    const stored = await this.#require(id);
    if (!(await this.#mayManage(stored, by, true))) {
      throw new AppError('host_required', { detail: SESSION_DETAILS.hostOnly });
    }
    if (isFinal(stored.row.state)) return toSession(stored);
    transition(stored.row.state, 'end');
    const ended = await this.#repo.transition(id, sourcesOf('end'), 'ended', {
      at: new Date(this.#clock()),
      endReason: by.reason,
      eventType: 'session.ended',
    });
    if (ended === null) return toSession(await this.#require(id));
    this.#counted('ended');
    await this.deliverOutbox(this.#clock(), id);
    return toSession(ended);
  }

  /** The relay: the host connected. A paused session goes back to live (one notification). */
  async onHostConnected(id: string): Promise<Session | null> {
    const at = new Date(this.#clock());
    const stored = await this.#repo.get(id);
    if (stored === null) return null;
    if (stored.row.state === 'paused') {
      const live = await this.#repo.transition(id, sourcesOf('host_returned'), 'live', {
        at,
        eventType: 'session.started',
        hostSeen: true,
      });
      if (live !== null) {
        this.#counted('live');
        await this.deliverOutbox(this.#clock(), id);
        return toSession(live);
      }
    }
    await this.#repo.setHostSeen(id, true, at);
    return this.get(id);
  }

  /** The relay: the host's last connection closed at `at`. */
  async onHostDisconnected(id: string, at: Date): Promise<void> {
    await this.#repo.setHostSeen(id, false, at);
  }

  /** The host-loss decision for `id` now, given the relay's connected editors. */
  async hostLoss(id: string, editors: readonly ConnectedEditor[]): Promise<HostLossDecision> {
    const stored = await this.#require(id);
    const { row } = stored;
    if (row.state !== 'live' && row.state !== 'pending') return { failover: null, pause: false };
    return evaluateHostLoss({
      hostAbsentSince: row.host_connected ? null : row.last_host_seen_at.getTime(),
      now: this.#clock(),
      autoFailover: stored.policy?.auto_failover ?? false,
      editors,
    });
  }

  /**
   * Pauses sessions whose host has been gone past the grace and expires sessions paused 24 h,
   * then delivers pending notifications. Idempotent; a concurrent sweep reports 0 and 0.
   */
  async sweep(now: Date): Promise<{ paused: number; expired: number }> {
    const result = await this.#repo.sweep(
      now,
      new Date(now.getTime() - HOST_GRACE_MS),
      new Date(now.getTime() - PAUSED_EXPIRY_MS),
      SWEEP_BATCH,
    );
    const counts = { paused: result?.paused.length ?? 0, expired: result?.expired.length ?? 0 };
    if (counts.paused > 0) this.#counted('paused', counts.paused);
    if (counts.expired > 0) this.#counted('expired', counts.expired);
    await this.deliverOutbox(now.getTime());
    if (result !== null) {
      this.#deps.logger?.info(counts, 'session.sweep');
    }
    return counts;
  }

  /** Delivers due outbox rows (of `sessionId` only, when given); the number fully delivered. */
  async deliverOutbox(nowMs: number, sessionId?: string): Promise<number> {
    const now = new Date(nowMs);
    const rows = await this.#repo.pendingOutbox(now, OUTBOX_BATCH, sessionId);
    let delivered = 0;
    for (const row of rows) {
      if (await this.#deliver(row, now)) delivered += 1;
    }
    return delivered;
  }

  async #deliver(row: OutboxRow, now: Date): Promise<boolean> {
    let relay = row.relaySent;
    let event = row.eventSent || row.eventType === null || row.workspaceId === null;
    if (!relay) {
      try {
        await this.#deps.relay.notify(row.sessionId, row.currentState);
        relay = true;
      } catch {
        this.#metrics.counter('session_outbox_failed_total', { target: 'relay' }).inc();
      }
    }
    if (!event && row.eventType !== null && row.workspaceId !== null) {
      try {
        await this.#deps.events.publish({
          id: row.eventId,
          type: row.eventType,
          workspace: row.workspaceId,
          created_at: row.createdAt.toISOString(),
          data: {
            session: row.sessionId,
            host: row.host ?? row.createdBy,
            name: row.name,
            state: row.state,
          },
        });
        event = true;
      } catch {
        this.#metrics.counter('session_outbox_failed_total', { target: 'event' }).inc();
      }
    }
    const done = relay && event;
    const attempts = row.attempts + 1;
    const retryAt = done
      ? null
      : new Date(
          now.getTime() + Math.min(OUTBOX_MAX_DELAY_MS, OUTBOX_BASE_DELAY_MS * 2 ** row.attempts),
        );
    try {
      await this.#repo.settleOutbox(row.id, { relay, event }, now, retryAt, attempts);
    } catch (err) {
      this.#deps.logger?.warn(
        { error: err instanceof Error ? err.name : typeof err },
        'session.outbox_settle_failed',
      );
    }
    if (!done) {
      this.#deps.logger?.warn({ session: row.sessionId, attempts }, 'session.outbox_retry');
    }
    return done;
  }

  #counted(state: SessionState, n = 1): void {
    this.#metrics.counter('session_transitions_total', { state }).inc(n);
  }
}
