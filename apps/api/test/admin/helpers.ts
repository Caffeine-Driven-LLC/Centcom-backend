/**
 * Test helpers for the internal admin API (B087): an in-memory AdminStore with the Postgres one's
 * semantics (a transaction's writes and audit rows commit together or not at all; the audit rows
 * go through the real emitter, so the catalogue and meta checks apply), real B017 tokens (staff,
 * plain users, relay tickets, API keys), B083's FlagAdmin and B086's StatusAdmin over their
 * in-memory repositories, fakes for entitlements, invites and promotions, and the admin listener
 * from `createAdminServer`.
 */
import { randomBytes } from 'node:crypto';
import { newId } from '@centcom/contracts';
import {
  AppError,
  AUTH_REVOCATIONS_CHANNEL,
  createAuditEmitter,
  type AuditDb,
  type AuditEvent,
} from '@centcom/core';
import type { StaffRole } from '@centcom/db';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { CompiledQuery, QueryResult } from 'kysely';
import type { Api } from '@centcom/contracts';
import { ADMIN_AUDIT_ACTIONS, type AdminAuditAction } from '../../src/modules/admin/actions.js';
import { loginDisabled } from '../../src/modules/admin/login-gate.js';
import type {
  AdminReader,
  AdminStore,
  AdminWriter,
  CallDetails,
  DeviceRecord,
  MemberRecord,
  MembershipRecord,
  SessionRecord,
  StaffAuditRecord,
  StaffRecord,
  UserRecord,
  WorkspaceRecord,
} from '../../src/modules/admin/repository.js';
import { AdminService } from '../../src/modules/admin/service.js';
import { StaffDirectory } from '../../src/modules/admin/staff.js';
import { mintRelayTicket, type TokenService } from '../../src/modules/auth/tokens/index.js';
import { FLAG_AUDIT_ACTIONS } from '../../src/modules/flags/actions.js';
import { FlagAdmin } from '../../src/modules/flags/service.js';
import { StatusAdmin } from '../../src/modules/status/service.js';
import { createAdminServer, type AdminServerOptions } from '../../src/routes/internal-admin.js';
import type { Cidr } from '../../src/modules/admin/cidr.js';
import { auditRows, MemoryFlagRepository } from '../flags/helpers.js';
import { captureLogger, recordingMetrics } from '../helpers.js';
import { memoryTokens, testClock, type TestClock } from '../modules/auth/tokens/helpers.js';
import { KEYS } from '../modules/workspaces/helpers.js';
import { MemoryStatusRepository } from '../status/helpers.js';

export { newId };

/** The base path. */
export const BASE = '/internal/admin/v1';
/** A reason that passes. */
export const REASON = 'Customer ticket: cannot sign in on the CLI';

/** A committed `staff.access` row, as audit_events and staff_audit_details hold it. */
export interface AuditRow {
  id: string;
  actor_type: string;
  actor_id: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  outcome: string;
  request_id: string | null;
  meta: Record<string, unknown>;
  created_at: Date;
  reason: string | null;
  ticket: string | null;
}

const connectionError = (): Error =>
  Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:5432'), { code: 'ECONNREFUSED' });

interface State {
  users: Map<string, UserRecord>;
  devices: Map<string, DeviceRecord & { user_id: string }>;
  memberships: (MembershipRecord & { user_id: string })[];
  workspaces: Map<string, WorkspaceRecord>;
  sessions: Map<string, SessionRecord>;
  staff: Map<string, StaffRecord>;
  rows: AuditRow[];
}

const cloneState = (s: State): State => structuredClone(s);

/** An in-memory AdminStore. */
export class MemoryAdminStore implements AdminStore {
  state: State = {
    users: new Map(),
    devices: new Map(),
    memberships: [],
    workspaces: new Map(),
    sessions: new Map(),
    staff: new Map(),
    rows: [],
  };
  /** Every read and transaction fails (Postgres down). */
  down = false;
  /** Writing an audit row fails. */
  auditFails = false;
  /** Committing fails (after everything in the transaction succeeded). */
  commitFails = false;
  /** Transactions committed. */
  commits = 0;
  readonly reader: AdminReader;
  readonly #emitter;

  constructor(clock: () => number) {
    this.#emitter = createAuditEmitter<AdminAuditAction>({
      db: { isTransaction: false, executeQuery: () => Promise.resolve({ rows: [] }) },
      actions: ADMIN_AUDIT_ACTIONS,
      clock,
    });
    this.reader = this.#readerOf(() => this.state);
  }

  #check(): void {
    if (this.down) throw connectionError();
  }

  #readerOf(state: () => State): AdminReader {
    const read = <T>(fn: (s: State) => T): Promise<T> => {
      try {
        this.#check();
        return Promise.resolve(structuredClone(fn(state())));
      } catch (err) {
        return Promise.reject(err as Error);
      }
    };
    return {
      user: (id) => read((s) => s.users.get(id) ?? null),
      userByEmail: (email) =>
        read(
          (s) =>
            [...s.users.values()].find((u) => u.email.toLowerCase() === email.toLowerCase()) ??
            null,
        ),
      devices: (userId) =>
        read((s) =>
          [...s.devices.values()]
            .filter((d) => d.user_id === userId)
            .map((d): DeviceRecord => ({
              id: d.id,
              name: d.name,
              platform: d.platform,
              created_at: d.created_at,
              last_seen_at: d.last_seen_at,
              revoked_at: d.revoked_at,
            })),
        ),
      memberships: (userId) =>
        read((s) =>
          s.memberships
            .filter((m) => m.user_id === userId)
            .map((m): MembershipRecord => ({
              id: m.id,
              workspace_id: m.workspace_id,
              role: m.role,
              created_at: m.created_at,
            })),
        ),
      workspace: (id) => read((s) => s.workspaces.get(id) ?? null),
      members: (workspaceId, limit) =>
        read((s) => {
          const all = s.memberships.filter((m) => m.workspace_id === workspaceId);
          const rows: MemberRecord[] = all.slice(0, limit).map((m) => {
            const u = s.users.get(m.user_id);
            return {
              id: m.id,
              user_id: m.user_id,
              email: u?.email ?? '',
              display_name: u?.display_name ?? '',
              role: m.role,
              created_at: m.created_at,
            };
          });
          return { rows, total: all.length };
        }),
      session: (id) => read((s) => s.sessions.get(id) ?? null),
      staff: (userId) => read((s) => s.staff.get(userId) ?? null),
      staffAudit: (q) =>
        read((s) => {
          const after = q.after;
          return s.rows
            .filter((r) => r.action === 'staff.access')
            .filter((r) => q.actor === undefined || r.actor_id === q.actor)
            .filter((r) => q.target === undefined || r.target_id === q.target)
            .sort((a, b) =>
              b.created_at.getTime() !== a.created_at.getTime()
                ? b.created_at.getTime() - a.created_at.getTime()
                : b.id < a.id
                  ? -1
                  : 1,
            )
            .filter(
              (r) =>
                after === undefined ||
                r.created_at.getTime() < Date.parse(after.at) ||
                (r.created_at.getTime() === Date.parse(after.at) && r.id < after.id),
            )
            .slice(0, q.limit)
            .map((r): StaffAuditRecord => ({
              id: r.id,
              created_at: r.created_at,
              actor_type: r.actor_type,
              actor_id: r.actor_id,
              outcome: r.outcome as StaffAuditRecord['outcome'],
              target_type: r.target_type,
              target_id: r.target_id,
              meta: r.meta,
              reason: r.reason,
              ticket: r.ticket,
            }));
        }),
    };
  }

  async transaction<T>(fn: (tx: AdminWriter) => Promise<T>): Promise<T> {
    this.#check();
    const working = cloneState(this.state);
    const emitter = this.#emitter;
    const fails = (): boolean => this.auditFails;
    const writer: AdminWriter = {
      ...this.#readerOf(() => working),
      disableLogin(userId, at) {
        const user = working.users.get(userId);
        if (user === undefined) return Promise.resolve(null);
        user.login_disabled_at ??= at;
        return Promise.resolve(user.login_disabled_at);
      },
      endSession(id, at) {
        const s = working.sessions.get(id);
        if (s === undefined) return Promise.resolve(false);
        if (s.state !== 'ended' && s.state !== 'expired') s.state = 'ended';
        s.ended_at ??= at;
        return Promise.resolve(true);
      },
      putStaff(userId, role, by, at) {
        const previous = working.staff.get(userId);
        const row: StaffRecord = {
          user_id: userId,
          role,
          added_by: by,
          added_at: previous?.added_at ?? at,
          disabled_at: null,
        };
        working.staff.set(userId, row);
        return Promise.resolve(structuredClone(row));
      },
      disableStaff(userId, at) {
        const row = working.staff.get(userId);
        if (row === undefined) return Promise.resolve(null);
        row.disabled_at ??= at;
        return Promise.resolve(structuredClone(row));
      },
      async record(event: AuditEvent<AdminAuditAction>, details: CallDetails) {
        if (fails()) throw connectionError();
        const written: Record<string, unknown>[] = [];
        const trx: AuditDb = {
          isTransaction: true,
          executeQuery: <R>(query: CompiledQuery<R>): Promise<QueryResult<R>> => {
            written.push(...auditRows(query));
            return Promise.resolve({ rows: [] });
          },
        };
        const id = await emitter.emit(trx, event);
        for (const r of written) {
          working.rows.push({
            id: r['id'] as string,
            actor_type: r['actor_type'] as string,
            actor_id: r['actor_id'] as string,
            action: r['action'] as string,
            target_type: (r['target_type'] as string | null) ?? null,
            target_id: (r['target_id'] as string | null) ?? null,
            outcome: r['outcome'] as string,
            request_id: (r['request_id'] as string | null) ?? null,
            meta: JSON.parse(r['meta'] as string) as Record<string, unknown>,
            created_at: r['created_at'] as Date,
            reason: details.reason,
            ticket: details.ticket,
          });
        }
        return id;
      },
    };
    const value = await fn(writer);
    if (this.commitFails) throw connectionError();
    this.state = working;
    this.commits += 1;
    return value;
  }

  /** The committed `staff.access` rows, oldest first. */
  rows(): AuditRow[] {
    return this.state.rows.filter((r) => r.action === 'staff.access');
  }

  addUser(over: Partial<UserRecord> = {}): UserRecord {
    const id = over.id ?? newId('usr');
    const user: UserRecord = {
      id,
      email: `${id.slice(4, 12).toLowerCase()}@example.test`,
      display_name: 'Pat Example',
      status: 'active',
      created_at: new Date(Date.UTC(2026, 0, 2)),
      deletion_requested_at: null,
      login_disabled_at: null,
      ...over,
    };
    this.state.users.set(id, user);
    return user;
  }

  addDevice(userId: string): DeviceRecord {
    const device = {
      id: newId('dev'),
      user_id: userId,
      name: 'Work laptop',
      platform: 'linux',
      created_at: new Date(Date.UTC(2026, 0, 3)),
      last_seen_at: null,
      revoked_at: null,
    };
    this.state.devices.set(device.id, device);
    return device;
  }

  addWorkspace(ownerId: string, members: { userId: string; role: Api.Role }[] = []): string {
    const id = newId('wsp');
    this.state.workspaces.set(id, {
      id,
      name: 'Acme',
      slug: `acme-${id.slice(-6).toLowerCase()}`,
      created_at: new Date(Date.UTC(2026, 0, 4)),
      deleted_at: null,
    });
    for (const m of [{ userId: ownerId, role: 'owner' as Api.Role }, ...members]) {
      this.state.memberships.push({
        id: newId('mem'),
        user_id: m.userId,
        workspace_id: id,
        role: m.role,
        created_at: new Date(Date.UTC(2026, 0, 5)),
      });
    }
    return id;
  }

  addSession(workspaceId: string | null): SessionRecord {
    const session: SessionRecord = {
      id: newId('ses'),
      workspace_id: workspaceId,
      state: 'live',
      region: 'eu',
      created_at: new Date(Date.UTC(2026, 0, 6)),
      ended_at: null,
      member_count: 3,
      host_member: newId('mem'),
    };
    this.state.sessions.set(session.id, session);
    return session;
  }

  addStaff(userId: string, role: StaffRole, disabled = false): void {
    this.state.staff.set(userId, {
      user_id: userId,
      role,
      added_by: null,
      added_at: new Date(Date.UTC(2026, 0, 1)),
      disabled_at: disabled ? new Date(Date.UTC(2026, 0, 7)) : null,
    });
  }
}

/** B086's in-memory repository, whose writes also fail while it is down. */
export class StatusRepository extends MemoryStatusRepository {
  override createIncident(
    incident: Parameters<MemoryStatusRepository['createIncident']>[0],
  ): Promise<void> {
    return this.down ? Promise.reject(connectionError()) : super.createIncident(incident);
  }

  override addUpdate(...args: Parameters<MemoryStatusRepository['addUpdate']>): Promise<boolean> {
    return this.down ? Promise.reject(connectionError()) : super.addUpdate(...args);
  }
}

/** Entitlements as B069 would answer, with fields the admin API must never pass on. */
export class FakeEntitlements {
  down = false;
  get(workspaceId: string): Promise<Api.Entitlements | null> {
    if (this.down) return Promise.reject(connectionError());
    return Promise.resolve({
      workspace: workspaceId,
      rev: 4,
      plan: 'team',
      status: 'active',
      period: { start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' },
      limits: { max_seats: 10 } as unknown as Api.Entitlements['limits'],
      usage: { seats: 3, hosted_minutes_month: 120, queue_items_month: 40 },
      grace_until: null,
      // A careless dependency: none of this may reach a response.
      stripe_customer_id: 'cus_N9rQ2bXk4LmPz8Tw',
      webhook_secret: 'whsec_abcdefghijklmnop',
      key_bundle: 'AAAA',
    } as unknown as Api.Entitlements);
  }
}

/** The invite resender B029 will provide. */
export class FakeInvites {
  calls: string[] = [];
  resend(inviteId: string): Promise<{ invite: string; workspace: string; expires_at: string }> {
    this.calls.push(inviteId);
    if (inviteId.endsWith('0000000000')) {
      return Promise.reject(new AppError('not_found', { detail: 'There is no such invite.' }));
    }
    return Promise.resolve({
      invite: inviteId,
      workspace: 'wsp_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
      expires_at: '2026-10-15T12:00:00.000Z',
      // Must not reach the response.
      token: 'inv_secret_token_value',
    } as { invite: string; workspace: string; expires_at: string });
  }
}

/** B079's grantPromotion. */
export class FakePromotions {
  calls: { workspaceId: string; code: string; actor: unknown }[] = [];
  grantPromotion(workspaceId: string, code: string, actor: unknown): Promise<Api.Subscription> {
    this.calls.push({ workspaceId, code, actor });
    return Promise.resolve({
      id: newId('sub'),
      workspace: workspaceId,
      plan: 'pro',
      status: 'active',
      seats: 1,
      current_period_end: '2026-11-01T00:00:00.000Z',
      stripe_subscription_id: 'sub_1MowQVLkdIwHu7ixeRlqHVzs',
      latest_invoice: 'in_1MtHbELkdIwHu7ixl4OzzPMv',
    } as unknown as Api.Subscription);
  }
}

/** The admin listener with everything behind it. */
export interface AdminWorld {
  app: FastifyInstance;
  store: MemoryAdminStore;
  tokens: TokenService;
  tokenStore: ReturnType<typeof memoryTokens>['store'];
  redis: ReturnType<typeof memoryTokens>['redis'];
  clock: TestClock;
  directory: StaffDirectory;
  flagRepo: MemoryFlagRepository;
  flagAdmin: FlagAdmin;
  statusRepo: StatusRepository;
  entitlements: FakeEntitlements;
  invites: FakeInvites;
  promotions: FakePromotions;
  /** Messages on `centcom:auth-revocations`. */
  announced: string[];
  captured: ReturnType<typeof captureLogger>;
  recorded: ReturnType<typeof recordingMetrics>;
  /** What the listener was built from, for building another. */
  serverOptions: Omit<AdminServerOptions, 'allowedCidrs'>;
  /** A staff member of `role` (a user, a staff row and an access token with `admin`). */
  staff(role: StaffRole): Promise<{ userId: string; token: string }>;
  /** An access token for `userId` (a new user by default) with `scopes`. */
  userToken(scopes?: string[], userId?: string): Promise<{ userId: string; token: string }>;
  /** A relay ticket (`aud` centcom-relay): never an API credential. */
  relayTicket(): Promise<string>;
  /** An API key credential that B019's resolver accepts. */
  apiKey(): string;
  /** A call on the admin listener. */
  call(
    method: string,
    path: string,
    opts?: {
      token?: string;
      reason?: string | null;
      ticket?: string;
      body?: unknown;
      headers?: Record<string, string>;
    },
  ): Promise<LightMyRequestResponse>;
  close(): Promise<void>;
}

/** A started admin world. `invites` and `promotions` false: their ports are not wired. */
export async function adminWorld(
  opts: {
    invites?: boolean;
    promotions?: boolean;
    components?: { id: string; name: string }[];
    /** Default 127.0.0.0/8. */
    allowedCidrs?: Cidr[];
  } = {},
): Promise<AdminWorld> {
  const captured = captureLogger();
  const recorded = recordingMetrics();
  const clock = testClock();
  const store = new MemoryAdminStore(clock.now);
  const signInGate = {
    assertCanSignIn: (userId: string): Promise<void> =>
      (store.state.users.get(userId)?.login_disabled_at ?? null) === null
        ? Promise.resolve()
        : Promise.reject(loginDisabled()),
  };
  const { tokens, store: tokenStore, redis, keys } = memoryTokens({ clock, signInGate });
  const apiKeys = new Set<string>();
  tokens.registerPrincipalResolver('cen_', (credential) =>
    apiKeys.has(credential)
      ? Promise.resolve({
          kind: 'api_key',
          userId: null,
          deviceId: null,
          workspaceId: newId('wsp'),
          scopes: ['admin', 'audit:read'],
          keyId: newId('key'),
        })
      : Promise.reject(new AppError('token_invalid', { detail: 'The API key is not valid.' })),
  );
  const announced: string[] = [];
  await redis.pubsub.subscribe(AUTH_REVOCATIONS_CHANNEL, (message) => announced.push(message));
  const flagRepo = new MemoryFlagRepository();
  const flagAdmin = new FlagAdmin({
    repository: flagRepo,
    emitter: createAuditEmitter({
      db: { isTransaction: false, executeQuery: () => Promise.resolve({ rows: [] }) },
      actions: FLAG_AUDIT_ACTIONS,
      clock: clock.now,
    }),
    pubsub: redis.pubsub,
    config: { maxCount: 500, maxValueBytes: 2048 },
    clock: clock.now,
  });
  const statusRepo = new StatusRepository();
  const statusAdmin = new StatusAdmin({
    repository: statusRepo,
    components: (opts.components ?? [{ id: 'api', name: 'API' }]).map((c) => ({
      ...c,
      probe: null,
    })),
    clock: clock.now,
  });
  const directory = new StaffDirectory({ reader: store.reader, clock: clock.now });
  const entitlements = new FakeEntitlements();
  const invites = new FakeInvites();
  const promotions = new FakePromotions();
  const service = new AdminService({
    store,
    tokens,
    directory,
    flags: flagAdmin,
    status: statusAdmin,
    cursorKeys: KEYS,
    entitlements,
    ...(opts.invites === false ? {} : { invites }),
    ...(opts.promotions === false ? {} : { promotions }),
    pubsub: redis.pubsub,
    clock: clock.now,
    logger: captured.logger,
  });
  const serverOptions = {
    service,
    store,
    access: { tokens, directory, rateLimit: redis.rateLimit },
    logger: captured.logger,
    metrics: recorded.metrics,
  };
  const app = await createAdminServer({
    ...serverOptions,
    allowedCidrs: opts.allowedCidrs ?? [{ address: '127.0.0.0', prefix: 8, family: 'ipv4' }],
  });
  // The allowlist above is for real sockets; inject() has none.
  await app.ready();

  const userToken = async (scopes: string[] = ['profile'], userId?: string) => {
    const id = userId ?? store.addUser().id;
    const issued = await tokens.issueTokens({ userId: id, deviceId: null, scopes });
    return { userId: id, token: issued.access_token };
  };

  return {
    app,
    store,
    tokens,
    tokenStore,
    redis,
    clock,
    directory,
    flagRepo,
    flagAdmin,
    statusRepo,
    entitlements,
    invites,
    promotions,
    announced,
    captured,
    recorded,
    serverOptions,
    async staff(role) {
      const user = store.addUser();
      store.addStaff(user.id, role);
      return userToken(['admin'], user.id);
    },
    userToken,
    relayTicket: () =>
      mintRelayTicket(
        keys,
        { sid: newId('ses'), mid: newId('mem'), role: 'host', dev: newId('dev'), caps: [] },
        clock.now(),
      ),
    apiKey() {
      const credential = ['cen', 'test', randomBytes(16).toString('hex')].join('_');
      apiKeys.add(credential);
      return credential;
    },
    call(method, path, o = {}) {
      const headers: Record<string, string> = { ...o.headers };
      if (o.token !== undefined) headers['authorization'] = `Bearer ${o.token}`;
      if (o.reason !== null) headers['x-admin-reason'] = o.reason ?? REASON;
      if (o.ticket !== undefined) headers['x-admin-ticket'] = o.ticket;
      return app.inject({
        method: method as 'GET',
        url: path.startsWith('/') ? path : `${BASE}/${path}`,
        headers,
        ...(o.body === undefined ? {} : { payload: o.body as object }),
      });
    },
    async close() {
      await app.close();
    },
  };
}
