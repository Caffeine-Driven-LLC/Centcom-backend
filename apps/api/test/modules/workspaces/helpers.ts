/**
 * Test helpers for workspaces (B027): an in-memory WorkspaceStore with the Postgres store's
 * semantics (transactions that roll back on a throw and run one at a time, as the row locks make
 * them; live-only reads; keyset pages; purge), and the routes on the API's plugin stack:
 * request context, errors, idempotency, RBAC over the store's memberships (its denials audited
 * through B036's sink), audit and the workspace routes. Callers are named by headers.
 */
import { randomBytes } from 'node:crypto';
import { newId } from '@centcom/contracts';
import {
  createAuditEmitter,
  createAuthorizer,
  createMemoryRedis,
  DEFAULT_EXEMPT_ROUTES,
  defaultBuckets,
  paginateArray,
  rbacAuditSink,
  Secret,
  type Actor,
  type AuditDb,
  type AuditEmitter,
  type MembershipReader,
  type PubSub,
  type RateLimitPrincipal,
  type RedisBackend,
  type SigningKeys,
  type WorkspaceRole,
} from '@centcom/core';
import type {
  NewWorkspace,
  WorkspaceRecord,
  WorkspaceStore,
  WorkspaceTx,
  WorkspaceView,
} from '@centcom/db';
import { fastify, type FastifyInstance } from 'fastify';
import type { CompiledQuery, QueryResult } from 'kysely';
import { auditPlugin } from '../../../src/plugins/audit.js';
import { errorHandlerPlugin } from '../../../src/plugins/error-handler.js';
import { idempotencyPlugin } from '../../../src/plugins/idempotency.js';
import { rateLimitPlugin } from '../../../src/plugins/rate-limit.js';
import { rbacPlugin } from '../../../src/plugins/rbac.js';
import { requestContextPlugin } from '../../../src/plugins/request-context.js';
import {
  createPatchExtensionRegistry,
  WorkspaceService,
  workspaceRoutes,
  type PatchExtensionRegistry,
  type PurgeQueue,
} from '../../../src/modules/workspaces/index.js';
import { captureLogger, recordingMetrics } from '../../helpers.js';

/** Cursor signing keys for the tests. */
export const KEYS: SigningKeys = [
  { id: 'k1', secret: new Secret(new Uint8Array(randomBytes(32))) },
];

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

interface Row {
  id: string;
  name: string;
  slug: string;
  version: number;
  createdAt: Date;
  createdBy: string;
  deletedAt: Date | null;
}

/** A membership as the store keeps it. */
export interface Membership {
  id: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  joinedAt: Date;
}

/** The in-memory store; its state is public for tests to look at and arrange. */
export class MemoryWorkspaceStore implements WorkspaceStore {
  readonly users = new Set<string>();
  /** Users' names and addresses (B028's member lists). */
  readonly profiles = new Map<string, { displayName: string; email: string }>();
  workspaces = new Map<string, Row>();
  memberships: Membership[] = [];
  /** Audit rows of committed transactions. */
  audit: Record<string, unknown>[] = [];
  /** Purges asked for, and whether each found anything. */
  readonly purges: { workspaceId: string; purged: boolean }[] = [];
  /** Milliseconds for `created_at`; each create moves it on 1 ms, so creation order is kept. */
  now = Date.UTC(2026, 9, 7, 12, 0, 0);
  /** When set, `insert` reports this many slug collisions before succeeding. */
  slugRaces = 0;
  #turn: Promise<unknown> = Promise.resolve();

  /** Adds a user who can create workspaces (named `User <n>`, at `<id>@example.test`). */
  addUser(userId = newId('usr')): string {
    this.users.add(userId);
    if (!this.profiles.has(userId)) {
      this.profiles.set(userId, {
        displayName: `User ${this.profiles.size + 1}`,
        email: `${userId.toLowerCase()}@example.test`,
      });
    }
    return userId;
  }

  /** Makes `userId` a member of `workspaceId` with `role`; returns the `mem_` id. */
  join(workspaceId: string, userId: string, role: WorkspaceRole): string {
    this.addUser(userId);
    this.now += 1;
    const id = newId('mem');
    this.memberships.push({ id, workspaceId, userId, role, joinedAt: new Date(this.now) });
    return id;
  }

  /** B021's MembershipReader over this store (no role in a deleted workspace). */
  readonly reader: MembershipReader = {
    workspaceRole: (userId, workspaceId) => {
      const live = this.workspaces.get(workspaceId)?.deletedAt === null;
      const role = this.memberships.find(
        (m) => m.workspaceId === workspaceId && m.userId === userId,
      )?.role;
      return Promise.resolve(live && role !== undefined ? role : null);
    },
    sessionRole: () => Promise.resolve(null),
  };

  transaction<T>(fn: (tx: WorkspaceTx) => Promise<T>): Promise<T> {
    return this.exclusive((trx) => fn(this.#tx(trx)));
  }

  /**
   * Runs `fn` as one transaction over this store's state: one at a time, as Postgres's row locks
   * serialise the changes that matter; rolled back when it throws; its audit rows (written
   * through `trx`) kept only when it commits.
   */
  exclusive<T>(fn: (trx: AuditDb) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const saved = {
        workspaces: new Map([...this.workspaces].map(([k, v]) => [k, { ...v }])),
        memberships: this.memberships.map((m) => ({ ...m })),
        now: this.now,
      };
      const pending: Record<string, unknown>[] = [];
      const trx: AuditDb = {
        isTransaction: true,
        executeQuery: <R>(query: CompiledQuery<R>): Promise<QueryResult<R>> => {
          pending.push(...auditRows(query));
          return Promise.resolve({ rows: [] });
        },
      };
      try {
        const result = await fn(trx);
        this.audit.push(...pending);
        return result;
      } catch (err) {
        this.workspaces = saved.workspaces;
        this.memberships = saved.memberships;
        this.now = saved.now;
        throw err;
      }
    };
    // One transaction at a time: Postgres's row locks serialise the ones that matter.
    const result = this.#turn.then(run, run);
    this.#turn = result.catch(() => undefined);
    return result;
  }

  #record(row: Row): WorkspaceRecord {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      version: row.version,
      createdAt: row.createdAt,
    };
  }

  #tx(trx: AuditDb): WorkspaceTx {
    return {
      trx,
      lockUser: (userId) => Promise.resolve(this.users.has(userId)),
      countOwned: (userId) =>
        Promise.resolve(
          this.memberships.filter(
            (m) =>
              m.userId === userId &&
              m.role === 'owner' &&
              this.workspaces.get(m.workspaceId)?.deletedAt === null,
          ).length,
        ),
      slugsLike: (base) =>
        Promise.resolve(
          [...this.workspaces.values()]
            .map((w) => w.slug)
            .filter((slug) => slug === base || slug.startsWith(`${base}-`)),
        ),
      insert: (input: NewWorkspace) => {
        if (this.slugRaces > 0) {
          this.slugRaces -= 1;
          return Promise.resolve(null);
        }
        if ([...this.workspaces.values()].some((w) => w.slug === input.slug)) {
          return Promise.resolve(null);
        }
        this.now += 1;
        const row: Row = {
          id: input.id,
          name: input.name,
          slug: input.slug,
          version: 1,
          createdAt: new Date(this.now),
          createdBy: input.ownerId,
          deletedAt: null,
        };
        this.workspaces.set(row.id, row);
        this.memberships.push({
          id: input.membershipId,
          workspaceId: input.id,
          userId: input.ownerId,
          role: 'owner',
          joinedAt: new Date(this.now),
        });
        return Promise.resolve(this.#record(row));
      },
      lockLive: (workspaceId) => {
        const row = this.workspaces.get(workspaceId);
        return Promise.resolve(row?.deletedAt === null ? this.#record(row) : null);
      },
      update: (workspaceId, changes) => {
        const row = this.workspaces.get(workspaceId);
        if (row === undefined) throw new Error('update: no such row');
        if (changes.name !== undefined) row.name = changes.name;
        row.version += 1;
        return Promise.resolve(this.#record(row));
      },
      softDelete: (workspaceId) => {
        const row = this.workspaces.get(workspaceId);
        if (row?.deletedAt === null) {
          row.deletedAt = new Date(this.now);
          row.version += 1;
        }
        return Promise.resolve();
      },
    };
  }

  #view(row: Row, userId: string | null): WorkspaceView | null {
    if (row.deletedAt !== null) return null;
    const members = this.memberships.filter((m) => m.workspaceId === row.id);
    const mine = userId === null ? undefined : members.find((m) => m.userId === userId);
    if (userId !== null && mine === undefined) return null;
    return {
      ...this.#record(row),
      role: mine?.role ?? null,
      ownerId: members.find((m) => m.role === 'owner')?.userId ?? null,
      memberCount: members.length,
    };
  }

  findForMember(workspaceId: string, userId: string): Promise<WorkspaceView | null> {
    const row = this.workspaces.get(workspaceId);
    return Promise.resolve(row === undefined ? null : this.#view(row, userId));
  }

  findLive(workspaceId: string): Promise<WorkspaceView | null> {
    const row = this.workspaces.get(workspaceId);
    return Promise.resolve(row === undefined ? null : this.#view(row, null));
  }

  listForMember(
    userId: string,
    params: Parameters<WorkspaceStore['listForMember']>[1],
  ): ReturnType<WorkspaceStore['listForMember']> {
    const views = [...this.workspaces.values()]
      .map((row) => this.#view(row, userId))
      .filter((view): view is WorkspaceView => view !== null);
    return Promise.resolve(
      paginateArray(
        views,
        {
          // As Postgres prints a timestamptz, so the order matches the SQL store's.
          sorts: { created: { value: (v) => v.createdAt.toISOString(), direction: 'desc' } },
          id: (v) => v.id,
        },
        params,
      ),
    );
  }

  purge(workspaceId: string): Promise<{ purged: boolean }> {
    const row = this.workspaces.get(workspaceId);
    if (row !== undefined && row.deletedAt === null) {
      return Promise.reject(new Error('purge: the workspace is live'));
    }
    const purged = row !== undefined;
    this.workspaces.delete(workspaceId);
    this.memberships = this.memberships.filter((m) => m.workspaceId !== workspaceId);
    this.purges.push({ workspaceId, purged });
    return Promise.resolve({ purged });
  }
}

/** The headers of a user calling with `scopes` (default both workspace scopes). */
export const asUser = (
  userId: string,
  scopes = 'workspaces:read workspaces:write',
): Record<string, string> => ({ 'x-test-user': userId, 'x-test-scopes': scopes });

/** The headers of an API key of `workspaceId`. */
export const asKey = (
  workspaceId: string,
  scopes = 'workspaces:read workspaces:write',
  keyId = newId('key'),
): Record<string, string> => ({
  'x-test-key': keyId,
  'x-test-key-workspace': workspaceId,
  'x-test-scopes': scopes,
});

function actorOf(headers: Record<string, unknown>): Actor | null {
  const scopes = String(headers['x-test-scopes'] ?? '')
    .split(' ')
    .filter(Boolean);
  const key = headers['x-test-key'];
  if (typeof key === 'string') {
    return {
      kind: 'api_key',
      keyId: key,
      workspaceId: String(headers['x-test-key-workspace']),
      scopes,
    };
  }
  const user = headers['x-test-user'];
  return typeof user === 'string' ? { kind: 'user', userId: user, scopes } : null;
}

/** A recording queue, which can fail on demand. */
export interface RecordingQueue extends PurgeQueue {
  jobs: { name: string; data: unknown; opts: unknown }[];
  fail: boolean;
}

export interface WorkspacesApp<S extends WorkspaceStore = MemoryWorkspaceStore> {
  app: FastifyInstance;
  store: S;
  service: WorkspaceService;
  queue: RecordingQueue;
  redis: RedisBackend;
  /** Messages published, by channel. */
  published: { channel: string; message: string }[];
  emitter: AuditEmitter;
  /** Audit rows written outside a transaction (detached: denials), after `emitter.flush`. */
  detached: Record<string, unknown>[];
  extensions: PatchExtensionRegistry;
  captured: ReturnType<typeof captureLogger>;
  recorded: ReturnType<typeof recordingMetrics>;
}

/** Options of the test app. */
export interface WorkspacesAppOptions {
  maxOwned?: number;
  failPublish?: boolean;
  clock?: () => number;
  /** Where detached audit events go; default a recording pool (`detached`). */
  auditPool?: AuditDb;
  /** Registers B023's rate limiter with CT-PAGE's buckets (callers by their test headers). */
  rateLimit?: boolean;
  /** Registers more routes on the same stack, before the app is ready (B028's member routes). */
  beforeReady?: (
    app: FastifyInstance,
    ctx: {
      events: PubSub;
      captured: ReturnType<typeof captureLogger>;
      recorded: ReturnType<typeof recordingMetrics>;
    },
  ) => Promise<void>;
}

/** The workspace routes on the API's plugin stack, over a fresh in-memory store. */
export function workspacesApp(options: WorkspacesAppOptions = {}): Promise<WorkspacesApp> {
  const store = new MemoryWorkspaceStore();
  return buildWorkspacesApp(store, store.reader, options);
}

/** The workspace routes on the API's plugin stack, over `store`, with RBAC reading `reader`. */
export async function buildWorkspacesApp<S extends WorkspaceStore>(
  store: S,
  reader: MembershipReader,
  options: WorkspacesAppOptions = {},
): Promise<WorkspacesApp<S>> {
  const captured = captureLogger();
  const recorded = recordingMetrics();
  const redis = createMemoryRedis();
  const published: { channel: string; message: string }[] = [];
  const events = {
    ...redis.pubsub,
    publish: (channel: string, message: string): Promise<void> => {
      if (options.failPublish === true) return Promise.reject(new Error('redis down'));
      published.push({ channel, message });
      return redis.pubsub.publish(channel, message);
    },
  };
  const queue: RecordingQueue = {
    jobs: [],
    fail: false,
    add(name, data, opts) {
      if (queue.fail) return Promise.reject(new Error('queue down'));
      queue.jobs.push({ name, data, opts });
      return Promise.resolve({ id: 'job' });
    },
  };
  const detached: Record<string, unknown>[] = [];
  const pool: AuditDb = {
    isTransaction: false,
    executeQuery: <R>(query: CompiledQuery<R>): Promise<QueryResult<R>> => {
      detached.push(...auditRows(query));
      return Promise.resolve({ rows: [] });
    },
  };
  const emitter = createAuditEmitter({ db: options.auditPool ?? pool, logger: captured.logger });
  const extensions = createPatchExtensionRegistry();
  const service = new WorkspaceService({
    store,
    events,
    purgeQueue: queue,
    maxOwned: options.maxOwned ?? 20,
    extensions,
    logger: captured.logger,
    metrics: recorded.metrics,
  });
  const app = fastify({ logger: false });
  await app.register(requestContextPlugin, { logger: captured.logger });
  await app.register(errorHandlerPlugin, { logger: captured.logger });
  if (options.rateLimit === true) {
    await app.register(rateLimitPlugin, {
      store: redis.rateLimit,
      config: { buckets: defaultBuckets, trustedHops: 0, exempt: DEFAULT_EXEMPT_ROUTES },
      principal: (request): RateLimitPrincipal | null => {
        const actor = actorOf(request.headers);
        if (actor?.kind === 'user') return { kind: 'user', userId: actor.userId };
        if (actor?.kind === 'api_key') return { kind: 'api_key', keyId: actor.keyId };
        return null;
      },
    });
  }
  await app.register(idempotencyPlugin, {
    kv: redis.kv,
    // For routes whose responses carry a secret (B029's invite token).
    encryptionKey: new Secret(new Uint8Array(randomBytes(32))),
    principal: (request) => {
      const actor = actorOf(request.headers);
      return actor === null ? null : actor.kind === 'user' ? actor.userId : actor.keyId;
    },
  });
  await app.register(rbacPlugin, {
    authorizer: createAuthorizer({ memberships: reader, audit: rbacAuditSink(emitter) }),
    actor: (request) => actorOf(request.headers),
  });
  await app.register(auditPlugin, { emitter });
  await app.register(workspaceRoutes, {
    service,
    cursorKeys: KEYS,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  await options.beforeReady?.(app, { events, captured, recorded });
  await app.ready();
  return {
    app,
    store,
    service,
    queue,
    redis,
    published,
    emitter,
    detached,
    extensions,
    captured,
    recorded,
  };
}

/** Creates a workspace through the API as `userId`; returns its body and ETag. */
export async function createWorkspace(
  app: FastifyInstance,
  userId: string,
  name = 'Acme',
): Promise<{ id: string; etag: string; body: Record<string, unknown> }> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/workspaces',
    headers: asUser(userId),
    payload: { name },
  });
  if (res.statusCode !== 201) throw new Error(`create failed: ${res.statusCode} ${res.body}`);
  const body = res.json<Record<string, unknown>>();
  return { id: String(body['id']), etag: String(res.headers['etag']), body };
}
