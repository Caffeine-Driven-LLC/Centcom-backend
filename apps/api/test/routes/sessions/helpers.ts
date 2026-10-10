/**
 * Test helpers for the session routes (B054): one in-memory world (users, devices, workspaces,
 * memberships, sessions, session members, slots, the host outbox) behind
 *
 * - B053's real `SessionService` over an in-memory `SessionRepository` with the Postgres one's
 *   rules (conditional transitions, host member at slot 0, keyset pages newest first);
 * - an in-memory `SessionRouteStore` with the Postgres store's rules (one live row per user under
 *   the session lock, join order over every row, the claim's transaction rolled back on a throw,
 *   its audit rows kept only on commit);
 * - a fake B031 slot store and B080 entitlements built from `contracts/fixtures/entitlements/`;
 *
 * and the API's plugin stack: request context, errors, rate limits, B017's auth with the real
 * token service (Ed25519 test keys, which sign the relay tickets), idempotency, B021's RBAC over
 * the world's memberships, B036's audit, and the session routes. Callers are bearer tokens.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { checkName, newId } from '@centcom/contracts';
import {
  createAuditEmitter,
  createAuthorizer,
  createMemoryRedis,
  DEFAULT_EXEMPT_ROUTES,
  paginateArray,
  rbacAuditSink,
  Secret,
  type AuditDb,
  type MembershipReader,
  type SigningKeys,
  type WorkspaceRole,
} from '@centcom/core';
import type { SessionSlotStore, SlotAssignment } from '@centcom/db';
import { fastify, type FastifyInstance } from 'fastify';
import type { CompiledQuery, QueryResult } from 'kysely';
import { principalActor } from '../../../src/modules/apikeys/authenticator.js';
import type { CheckResult } from '../../../src/modules/entitlements/enforcement.js';
import {
  SessionService,
  type SessionPolicyDefaults,
  type SessionRepository,
  type SessionRow,
  type SessionState,
  type StoredSession,
} from '../../../src/modules/sessions/index.js';
import { auditPlugin } from '../../../src/plugins/audit.js';
import { authPlugin } from '../../../src/plugins/auth.js';
import { errorHandlerPlugin, frameworkErrorHandler } from '../../../src/plugins/error-handler.js';
import { idempotencyPlugin } from '../../../src/plugins/idempotency.js';
import { rateLimitPlugin } from '../../../src/plugins/rate-limit.js';
import { rbacPlugin } from '../../../src/plugins/rbac.js';
import { requestContextPlugin } from '../../../src/plugins/request-context.js';
import {
  registerSessionRoutes,
  type SessionRouteDeps,
  type SessionRouteStore,
} from '../../../src/routes/sessions/index.js';
import type {
  AddMemberResult,
  ClaimResult,
  MemberView,
  PatchResult,
} from '../../../src/routes/sessions/store.js';
import { captureLogger, recordingMetrics } from '../../helpers.js';
import { memoryTokens, testClock } from '../../modules/auth/tokens/helpers.js';

/** The tests' epoch. */
export const T0 = Date.parse('2026-10-10T12:00:00.000Z');
/** Cursor signing keys. */
export const KEYS: SigningKeys = [
  { id: 'k1', secret: new Secret(new Uint8Array(randomBytes(32))) },
];
/** Every session scope (the CLI default holds all three). */
export const ALL_SCOPES = ['sessions:read', 'sessions:write', 'sessions:host'];
export const RELAYS = {
  defaultRegion: 'eu',
  urls: { eu: 'wss://eu.relay.centcom.dev', us: 'wss://us.relay.centcom.dev' },
};

type Plan = 'free' | 'pro' | 'team';

/** A plan's limits from the contract's fixtures. */
export function planLimits(plan: Plan): Record<string, unknown> {
  const doc = JSON.parse(
    readFileSync(
      new URL(`../../../../../contracts/fixtures/entitlements/${plan}.json`, import.meta.url),
      'utf8',
    ),
  ) as { data: { limits: Record<string, unknown> } };
  return doc.data.limits;
}

/** A 43-character base64url public key. */
const key = (): string => randomBytes(32).toString('base64url');

interface DeviceRow {
  userId: string;
  revoked: boolean;
  x25519: string;
  ed25519: string;
  fingerprint: string;
}
interface MemberRow {
  id: string;
  sessionId: string;
  userId: string;
  deviceId: string;
  role: 'host' | 'editor' | 'viewer';
  slot: number;
  joinedAt: Date;
  leftAt: Date | null;
}
interface HostOutbox {
  id: string;
  sessionId: string;
  code: 'failover';
  attempts: number;
  nextAttemptAt: Date;
}

/** The rows of an `insert into "audit_events"`, column by column. */
function auditRows(query: CompiledQuery): Record<string, unknown>[] {
  const list = /\(([^)]+)\) values/.exec(query.sql)?.[1] ?? '';
  const columns = list.split(', ').map((c) => c.replaceAll('"', ''));
  const rows: Record<string, unknown>[] = [];
  for (let at = 0; at < query.parameters.length; at += columns.length) {
    rows.push(Object.fromEntries(columns.map((c, i) => [c, query.parameters[at + i]])));
  }
  return rows;
}

/** Everything the fakes share; public so tests can arrange and inspect it. */
export class World {
  now = T0;
  users = new Map<string, string>();
  devices = new Map<string, DeviceRow>();
  workspaces = new Map<string, { deleted: boolean; plan: Plan }>();
  memberships: { workspaceId: string; userId: string; role: WorkspaceRole }[] = [];
  sessions = new Map<string, { row: SessionRow; policy: SessionPolicyDefaults | null }>();
  members: MemberRow[] = [];
  slots = new Map<string, Map<string, number>>();
  hostOutbox: HostOutbox[] = [];
  /** Members released after a join or claim that did not go through. */
  released: string[] = [];
  /** Audit rows of committed claim transactions. */
  audit: Record<string, unknown>[] = [];
  #outboxId = 0;
  #turn: Promise<unknown> = Promise.resolve();

  /** Runs `fn` alone, as the row and advisory locks serialise it; state restored on a throw. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const saved = {
        sessions: new Map(
          [...this.sessions].map(([k, v]) => [k, { row: { ...v.row }, policy: v.policy }]),
        ),
        members: this.members.map((m) => ({ ...m })),
        hostOutbox: this.hostOutbox.map((o) => ({ ...o })),
      };
      try {
        return await fn();
      } catch (err) {
        this.sessions = saved.sessions;
        this.members = saved.members;
        this.hostOutbox = saved.hostOutbox;
        throw err;
      }
    };
    const result = this.#turn.then(run, run);
    this.#turn = result.catch(() => undefined);
    return result;
  }

  /** A user with one live device. */
  person(name = 'Member'): { user: string; device: string } {
    const user = newId('usr');
    this.users.set(user, name);
    const device = newId('dev');
    this.devices.set(device, {
      userId: user,
      revoked: false,
      x25519: key(),
      ed25519: key(),
      fingerprint: 'ABCD-EFGH-IJKL',
    });
    return { user, device };
  }

  /** A workspace with one person per role. */
  workspace(plan: Plan = 'team') {
    const id = newId('wsp');
    this.workspaces.set(id, { deleted: false, plan });
    const people = {} as Record<WorkspaceRole, { user: string; device: string }>;
    for (const role of ['owner', 'admin', 'member', 'billing', 'guest'] as const) {
      people[role] = this.person(`The ${role}`);
      this.memberships.push({ workspaceId: id, userId: people[role].user, role });
    }
    const outsider = this.person('An outsider');
    return { id, ...people, outsider };
  }

  workspaceRole(workspaceId: string, userId: string): WorkspaceRole | null {
    if (this.workspaces.get(workspaceId)?.deleted !== false) return null;
    return (
      this.memberships.find((m) => m.workspaceId === workspaceId && m.userId === userId)?.role ??
      null
    );
  }

  /** `who` joins `sid` directly (as the relay or an earlier join-token left it). */
  addMember(sid: string, who: { user: string; device: string }, role: MemberRow['role']): string {
    const id = newId('mem');
    const slots = this.slots.get(sid) ?? new Map<string, number>();
    this.slots.set(sid, slots);
    const slot = Math.max(-1, ...slots.values()) + 1;
    slots.set(id, slot);
    this.now += 1;
    this.members.push({
      id,
      sessionId: sid,
      userId: who.user,
      deviceId: who.device,
      role,
      slot,
      joinedAt: new Date(this.now),
      leftAt: null,
    });
    return id;
  }

  /** B053's repository, in memory. */
  repository(): SessionRepository {
    const stored = (id: string): StoredSession | null => {
      const s = this.sessions.get(id);
      return s === undefined ? null : { row: { ...s.row }, policy: s.policy && { ...s.policy } };
    };
    const repo = {
      insert: (s: Parameters<SessionRepository['insert']>[0]) =>
        this.exclusive(() => {
          this.sessions.set(s.id, {
            row: {
              id: s.id,
              workspace_id: s.workspaceId,
              name: s.name,
              state: 'live',
              region: s.region,
              created_by: s.createdBy,
              created_at: s.at,
              ended_at: null,
              host_member_id: s.host.id,
              host_connected: false,
              last_host_seen_at: s.at,
              paused_at: null,
              expires_at: null,
              end_reason: null,
            },
            policy: s.policy ?? null,
          });
          this.members.push({
            id: s.host.id,
            sessionId: s.id,
            userId: s.host.userId,
            deviceId: s.host.deviceId,
            role: 'host',
            slot: 0,
            joinedAt: s.at,
            leftAt: null,
          });
          this.slots.set(s.id, new Map([[s.host.id, 0]]));
          return Promise.resolve(stored(s.id) as StoredSession);
        }),
      get: (id: string) => Promise.resolve(stored(id)),
      list: (
        q: Parameters<SessionRepository['list']>[0],
        paging: Parameters<SessionRepository['list']>[1],
      ) => {
        const items = [...this.sessions.keys()]
          .map((id) => stored(id) as StoredSession)
          .filter((s) => q.workspace === undefined || s.row.workspace_id === q.workspace)
          .filter((s) => q.state === undefined || s.row.state === q.state)
          .filter(
            (s) =>
              q.mineUserId === undefined ||
              this.members.some(
                (m) => m.sessionId === s.row.id && m.userId === q.mineUserId && m.leftAt === null,
              ),
          );
        return Promise.resolve(
          paginateArray(
            items,
            { sorts: { id: { value: (s) => s.row.id, direction: 'desc' } }, id: (s) => s.row.id },
            {
              limit: q.limit,
              ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
              sort: 'id',
              filterHash: paging.filterHash,
              keys: paging.keys,
              now: paging.now,
            },
          ),
        );
      },
      countActive: (workspaceId: string) =>
        Promise.resolve(
          [...this.sessions.values()].filter(
            (s) =>
              s.row.workspace_id === workspaceId &&
              ['pending', 'live', 'paused'].includes(s.row.state),
          ).length,
        ),
      workspaceRole: (workspaceId: string, userId: string) =>
        Promise.resolve(this.workspaceRole(workspaceId, userId)),
      memberOf: (sid: string, userId: string) =>
        Promise.resolve(
          this.members
            .filter((m) => m.sessionId === sid && m.userId === userId && m.leftAt === null)
            .sort((a, b) => b.joinedAt.getTime() - a.joinedAt.getTime())[0]?.id ?? null,
        ),
      transition: (
        id: string,
        from: readonly SessionState[],
        to: SessionState,
        patch: { at: Date; endReason?: SessionRow['end_reason']; hostSeen?: boolean },
      ) =>
        this.exclusive(() => {
          const s = this.sessions.get(id);
          if (s === undefined || !from.includes(s.row.state)) return Promise.resolve(null);
          s.row.state = to;
          if (to === 'ended' || to === 'expired') {
            s.row.ended_at = patch.at;
            s.row.end_reason = patch.endReason ?? null;
          }
          if (patch.hostSeen === true) s.row.host_connected = true;
          return Promise.resolve(stored(id));
        }),
      setHostSeen: (id: string, connected: boolean, at: Date) => {
        const s = this.sessions.get(id);
        if (s !== undefined) {
          s.row.host_connected = connected;
          s.row.last_host_seen_at = at;
        }
        return Promise.resolve();
      },
      rename: (id: string, name: string) => {
        const s = this.sessions.get(id);
        if (s === undefined || !['pending', 'live', 'paused'].includes(s.row.state)) {
          return Promise.resolve(false);
        }
        s.row.name = name;
        return Promise.resolve(true);
      },
      setPolicy: (id: string, policy: SessionPolicyDefaults) => {
        const s = this.sessions.get(id);
        if (s !== undefined) s.policy = { ...policy };
        return Promise.resolve();
      },
      sweep: () => Promise.resolve(null),
      pendingOutbox: () => Promise.resolve([]),
      settleOutbox: () => Promise.resolve(),
    };
    return repo as unknown as SessionRepository;
  }

  #view(m: MemberRow, order: number): MemberView {
    const s = this.sessions.get(m.sessionId);
    const d = this.devices.get(m.deviceId) as DeviceRow;
    const ws = s?.row.workspace_id ?? null;
    return {
      id: m.id,
      userId: m.userId,
      displayName: this.users.get(m.userId) ?? 'Member',
      role: m.role,
      slot: m.slot,
      joinOrder: order,
      joinedAt: m.joinedAt,
      device: {
        id: m.deviceId,
        x25519: d.x25519,
        ed25519: d.ed25519,
        fingerprint: d.fingerprint,
        revoked: d.revoked,
      },
      workspaceRole: ws === null ? null : this.workspaceRole(ws, m.userId),
    };
  }

  /** Members of `sid` with their join order (every row counts), live ones only. */
  #ranked(sid: string): MemberView[] {
    return this.members
      .filter((m) => m.sessionId === sid)
      .sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime() || (a.id < b.id ? -1 : 1))
      .map((m, i) => ({ m, order: i + 1 }))
      .filter(({ m }) => m.leftAt === null)
      .map(({ m, order }) => this.#view(m, order))
      .filter((v) => {
        const ws = this.sessions.get(sid)?.row.workspace_id ?? null;
        return ws === null || (v.workspaceRole !== null && v.workspaceRole !== 'billing');
      });
  }

  /** The routes' store, in memory. */
  store(): SessionRouteStore {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the store's methods read the world
    const world = this;
    const store = {
      standing(sid: string, userId: string) {
        const s = world.sessions.get(sid);
        if (s === undefined) return Promise.resolve(null);
        const rows = world.members
          .filter((m) => m.sessionId === sid && m.userId === userId)
          .sort((a, b) => b.joinedAt.getTime() - a.joinedAt.getTime());
        const live = rows.find((m) => m.leftAt === null);
        const ws = s.row.workspace_id;
        return Promise.resolve({
          session: {
            id: sid,
            workspaceId: ws,
            state: s.row.state,
            hostMemberId: s.row.host_member_id,
            hostConnected: s.row.host_connected,
            locked: s.policy?.locked === true,
          },
          member:
            live === undefined
              ? null
              : { id: live.id, role: live.role, deviceId: live.deviceId, slot: live.slot },
          removed: live === undefined && rows.length > 0,
          workspaceRole: ws === null ? null : world.workspaceRole(ws, userId),
        });
      },
      device(deviceId: string) {
        const d = world.devices.get(deviceId);
        return Promise.resolve(d === undefined ? null : { userId: d.userId, revoked: d.revoked });
      },
      countMembers(sid: string) {
        return Promise.resolve(
          world.members.filter((m) => m.sessionId === sid && m.leftAt === null).length,
        );
      },
      addMember(input: Parameters<SessionRouteStore['addMember']>[0]): Promise<AddMemberResult> {
        return world.exclusive<AddMemberResult>(() => {
          const s = world.sessions.get(input.sessionId);
          if (s === undefined) return Promise.resolve({ kind: 'gone' } as const);
          if (s.row.state === 'ended' || s.row.state === 'expired') {
            return Promise.resolve({ kind: 'over' } as const);
          }
          const existing = world.members.find(
            (m) =>
              m.sessionId === input.sessionId && m.userId === input.userId && m.leftAt === null,
          );
          if (existing !== undefined) {
            return Promise.resolve({
              kind: 'existing',
              member: { id: existing.id, role: existing.role, slot: existing.slot },
            } as const);
          }
          if (world.members.some((m) => m.sessionId === input.sessionId && m.slot === input.slot)) {
            throw new Error('session_members_session_id_slot_key');
          }
          world.members.push({
            id: input.memberId,
            sessionId: input.sessionId,
            userId: input.userId,
            deviceId: input.deviceId,
            role: input.role,
            slot: input.slot,
            joinedAt: input.at,
            leftAt: null,
          });
          return Promise.resolve({
            kind: 'added',
            member: { id: input.memberId, role: input.role, slot: input.slot },
          } as const);
        });
      },
      member(sid: string, mid: string) {
        return Promise.resolve(world.#ranked(sid).find((m) => m.id === mid) ?? null);
      },
      members(sid: string, after: number, limit: number) {
        return Promise.resolve(
          world
            .#ranked(sid)
            .filter((m) => m.joinOrder > after)
            .slice(0, limit + 1),
        );
      },
      claimHost(
        sid: string,
        claimantId: string,
        at: Date,
        audit: (trx: AuditDb) => Promise<void>,
      ): Promise<ClaimResult> {
        return world.exclusive(async () => {
          const s = world.sessions.get(sid);
          if (s === undefined) return { kind: 'gone' } as const;
          if (s.row.state === 'ended' || s.row.state === 'expired')
            return { kind: 'over' } as const;
          const hosts = world.members.filter(
            (m) => m.sessionId === sid && m.role === 'host' && m.leftAt === null,
          );
          if (
            s.row.host_member_id === claimantId &&
            hosts.length === 1 &&
            hosts[0]?.id === claimantId
          ) {
            return { kind: 'already' } as const;
          }
          if (s.row.host_connected) return { kind: 'host_present' } as const;
          const previous = s.row.host_member_id;
          const claimant = world.members.find(
            (m) => m.id === claimantId && m.sessionId === sid && m.leftAt === null,
          );
          if (claimant === undefined) return { kind: 'not_member' } as const;
          for (const h of hosts) if (h.id !== claimantId) h.role = 'editor';
          claimant.role = 'host';
          s.row.host_member_id = claimantId;
          s.row.host_connected = false;
          s.row.last_host_seen_at = at;
          world.#outboxId += 1;
          world.hostOutbox.push({
            id: String(world.#outboxId),
            sessionId: sid,
            code: 'failover',
            attempts: 0,
            nextAttemptAt: at,
          });
          await world.#audited(audit);
          return { kind: 'claimed', previousHost: previous } as const;
        });
      },
      releaseMember(sid: string, mid: string) {
        world.members = world.members.filter((m) => !(m.id === mid && m.sessionId === sid));
        world.slots.get(sid)?.delete(mid);
        world.released.push(mid);
        return Promise.resolve();
      },
      patchSession(
        sid: string,
        userId: string,
        change: { name?: string; policy?: Partial<SessionPolicyDefaults> },
        at: Date,
        check: (current: StoredSession) => void,
        audit: (trx: AuditDb) => Promise<void>,
      ): Promise<PatchResult> {
        return world.exclusive(async () => {
          const s = world.sessions.get(sid);
          if (s === undefined) return { kind: 'gone' } as const;
          const host = world.members.find(
            (m) =>
              m.sessionId === sid &&
              m.userId === userId &&
              m.leftAt === null &&
              m.id === s.row.host_member_id,
          );
          if (host === undefined) return { kind: 'not_host' } as const;
          if (s.row.state === 'ended' || s.row.state === 'expired')
            return { kind: 'over' } as const;
          check({ row: { ...s.row }, policy: s.policy && { ...s.policy } });
          // Each PATCH takes a turn, as the row lock makes it.
          await new Promise((resolve) => setImmediate(resolve));
          void at;
          if (change.name !== undefined) s.row.name = change.name;
          if (change.policy !== undefined) {
            s.policy = {
              auto_approve: 'ask',
              share_history: false,
              queue_limit: 20,
              locked: false,
              auto_failover: false,
              ...s.policy,
              ...change.policy,
            };
          }
          await world.#audited(audit);
          return {
            kind: 'patched',
            session: { row: { ...s.row }, policy: s.policy && { ...s.policy } },
          } as const;
        });
      },
      pendingHostChanges(now: Date, limit: number, sid?: string) {
        return Promise.resolve(
          world.hostOutbox
            .filter(
              (o) =>
                o.nextAttemptAt.getTime() <= now.getTime() &&
                (sid === undefined || o.sessionId === sid),
            )
            .slice(0, limit)
            .map((o) => ({
              id: o.id,
              sessionId: o.sessionId,
              code: o.code,
              attempts: o.attempts,
              host: world.sessions.get(o.sessionId)?.row.host_member_id ?? null,
            })),
        );
      },
      settleHostChange(id: string, retryAt: Date | null, attempts: number) {
        const o = world.hostOutbox.find((r) => r.id === id);
        if (o !== undefined) {
          o.attempts = attempts;
          if (retryAt === null) world.hostOutbox = world.hostOutbox.filter((r) => r.id !== id);
          else o.nextAttemptAt = retryAt;
        }
        return Promise.resolve();
      },
    };
    return store;
  }

  /** Runs `audit` on a recording transaction; its rows are kept with the change. */
  async #audited(audit: (trx: AuditDb) => Promise<void>): Promise<void> {
    const pending: Record<string, unknown>[] = [];
    await audit({
      isTransaction: true,
      executeQuery: <R>(query: CompiledQuery<R>): Promise<QueryResult<R>> => {
        pending.push(...auditRows(query));
        return Promise.resolve({ rows: [] });
      },
    });
    this.audit.push(...pending);
  }

  /** B031's slot store, in memory, with its cap. */
  slotStore(): Pick<SessionSlotStore, 'assign'> {
    return {
      assign: (sid, mid, cap): Promise<SlotAssignment> => {
        if (!this.sessions.has(sid)) return Promise.resolve({ kind: 'no_session' });
        const slots = this.slots.get(sid) ?? new Map<string, number>();
        this.slots.set(sid, slots);
        const held = slots.get(mid);
        if (held !== undefined)
          return Promise.resolve({ kind: 'assigned', slot: held, existing: true });
        const next = Math.max(-1, ...slots.values()) + 1;
        if (next >= cap) return Promise.resolve({ kind: 'full' });
        slots.set(mid, next);
        return Promise.resolve({ kind: 'assigned', slot: next, existing: false });
      },
    };
  }

  /** B080's check over the workspace's plan fixture; `mode` makes it fail. */
  entitlements(state: { mode: 'ok' | 'fail' }) {
    return {
      check: (workspaceId: string, key: string, current?: number): Promise<CheckResult> => {
        if (state.mode === 'fail') return Promise.reject(new Error('entitlements down'));
        const plan = this.workspaces.get(workspaceId)?.plan ?? 'free';
        const value = planLimits(plan)[key];
        if (key === 'relay_access') {
          return Promise.resolve(
            value === true ? { allowed: true } : { allowed: false, reason: 'flag_off' },
          );
        }
        if (value === null) return Promise.resolve({ allowed: true });
        const limit = typeof value === 'number' ? value : 0;
        return Promise.resolve(
          (current ?? 0) < limit ? { allowed: true } : { allowed: false, reason: 'count_reached' },
        );
      },
    };
  }

  /** B021's membership reader over the world. */
  readonly reader: MembershipReader = {
    workspaceRole: (userId, workspaceId) =>
      Promise.resolve(this.workspaceRole(workspaceId, userId)),
    sessionRole: (userId, sid) =>
      Promise.resolve(
        this.members.find((m) => m.sessionId === sid && m.userId === userId && m.leftAt === null)
          ?.role ?? null,
      ),
  };
}

/** Options of the test app. */
export interface SessionsAppOptions {
  world?: World;
  /** Overrides of the routes' dependencies. */
  deps?: Partial<SessionRouteDeps>;
  /** B021's membership reader; default the world's. */
  reader?: MembershipReader;
}

/** The session routes on the API's plugin stack over a fresh (or given) world. */
export async function sessionsApp(options: SessionsAppOptions = {}) {
  const world = options.world ?? new World();
  const clock = testClock(T0);
  const captured = captureLogger();
  const recorded = recordingMetrics();
  const { tokens, store: refresh, keys } = memoryTokens({ clock });
  const redis = createMemoryRedis(clock.now);
  const flags = {
    entitlements: { mode: 'ok' as 'ok' | 'fail' },
    failSigning: false,
    failRecord: false,
    failNotifier: false,
  };
  const entitlements = world.entitlements(flags.entitlements);
  const relayed: { sid: string; state: SessionState }[] = [];
  const service = new SessionService({
    repository: world.repository(),
    entitlements: { check: (ws, k, c) => entitlements.check(ws, k, c) },
    relay: {
      notify: (sid, state) => {
        relayed.push({ sid, state });
        return Promise.resolve();
      },
    },
    events: { publish: () => Promise.resolve() },
    cursorKeys: KEYS,
    clock: clock.now,
  });
  const store = world.store();
  const issued = new Map<string, { value: string; ttlMs: number | undefined }>();
  const hostChanges: { sid: string; host: string; code: string }[] = [];
  const deps: SessionRouteDeps = {
    service,
    store,
    slots: world.slotStore(),
    entitlements,
    tickets: {
      mintRelayTicket: (claims) =>
        flags.failSigning
          ? Promise.reject(new Error('no signing key'))
          : tokens.mintRelayTicket(claims),
    },
    issued: {
      set: (k, value, opts) => {
        if (flags.failRecord) return Promise.reject(new Error('redis down'));
        issued.set(k, { value, ttlMs: opts?.ttlMs });
        return Promise.resolve();
      },
    },
    hostNotifier: {
      hostChanged: (sid, host, code) => {
        if (flags.failNotifier) return Promise.reject(new Error('relay down'));
        hostChanges.push({ sid, host, code });
        return Promise.resolve();
      },
    },
    relays: RELAYS,
    cursorKeys: KEYS,
    clock: clock.now,
    logger: captured.logger,
    metrics: recorded.metrics,
    ...options.deps,
  };

  const detached: Record<string, unknown>[] = [];
  const pool: AuditDb = {
    isTransaction: false,
    executeQuery: <R>(query: CompiledQuery<R>): Promise<QueryResult<R>> => {
      detached.push(...auditRows(query));
      return Promise.resolve({ rows: [] });
    },
  };
  const emitter = createAuditEmitter({ db: pool, logger: captured.logger });
  const apiKeys = new Map<string, { workspaceId: string; scopes: string[]; keyId: string }>();
  tokens.registerPrincipalResolver('cen_', (credential) => {
    const k = apiKeys.get(credential);
    if (k === undefined) return Promise.reject(new Error('unknown key'));
    return Promise.resolve({
      kind: 'api_key',
      userId: null,
      deviceId: null,
      workspaceId: k.workspaceId,
      scopes: k.scopes,
      keyId: k.keyId,
    });
  });

  const app: FastifyInstance = fastify({
    logger: false,
    frameworkErrors: frameworkErrorHandler({ logger: captured.logger }),
  });
  await app.register(requestContextPlugin, { logger: captured.logger });
  await app.register(errorHandlerPlugin, { logger: captured.logger });
  await app.register(rateLimitPlugin, {
    store: redis.rateLimit,
    clock: clock.now,
    config: {
      buckets: {
        anonymous: { limit: 5000, windowS: 60 },
        user: { limit: 5000, windowS: 60 },
        apiKey: { limit: 5000, windowS: 60 },
        auth: { limit: 20, windowS: 60 },
        usage: { limit: 60, windowS: 60 },
      },
      trustedHops: 0,
      exempt: DEFAULT_EXEMPT_ROUTES,
    },
  });
  await app.register(authPlugin, { tokens });
  await app.register(idempotencyPlugin, {
    kv: redis.kv,
    encryptionKey: new Secret(new Uint8Array(randomBytes(32))),
    principal: (request) => request.principal?.userId ?? request.principal?.keyId ?? null,
  });
  await app.register(rbacPlugin, {
    authorizer: createAuthorizer({
      memberships: options.reader ?? world.reader,
      audit: rbacAuditSink(emitter),
    }),
    actor: (request) => principalActor(request.principal),
  });
  await app.register(auditPlugin, { emitter });
  registerSessionRoutes(app, deps);
  await app.ready();

  /** Bearer headers of `who` (their device) with `scopes`. */
  const as = async (
    who: { user: string; device: string },
    scopes: string[] = ALL_SCOPES,
  ): Promise<Record<string, string>> => {
    refresh.devices.set(who.device, { userId: who.user, revoked: false });
    const t = await tokens.issueTokens({ userId: who.user, deviceId: who.device, scopes });
    return { authorization: `Bearer ${t.access_token}` };
  };
  /** Bearer headers of a new API key of `workspaceId`. */
  const asKey = (workspaceId: string, scopes: string[] = ALL_SCOPES): Record<string, string> => {
    const credential = `cen_test_${randomBytes(24).toString('base64url').replace(/[-_]/g, 'a')}`;
    apiKeys.set(credential, { workspaceId, scopes, keyId: newId('key') });
    return { authorization: `Bearer ${credential}` };
  };
  /** Creates a session as `who` through the API; its body. */
  const create = async (
    who: { user: string; device: string },
    workspace: string,
    body: Record<string, unknown> = {},
  ): Promise<Record<string, unknown> & { id: string }> => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: await as(who),
      payload: { workspace, name: 'Release train', ...body },
    });
    if (res.statusCode !== 201) throw new Error(`create: ${res.statusCode} ${res.body}`);
    return res.json();
  };

  return {
    app,
    world,
    clock,
    keys,
    tokens,
    service,
    store,
    deps,
    flags,
    issued,
    hostChanges,
    relayed,
    detached: async () => {
      await emitter.flush(1000);
      return detached;
    },
    captured,
    recorded,
    as,
    asKey,
    create,
  };
}

/** Checks a name the way B053 does (for building expectations). */
export const validName = (name: string): boolean => checkName('sessionName', name).ok;
