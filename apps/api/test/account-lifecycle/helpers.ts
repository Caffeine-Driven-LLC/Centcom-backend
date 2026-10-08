/**
 * Test helpers for the account lifecycle (B026): an in-memory store with the Postgres store's
 * rules (one transaction at a time, the sole-owner check, the first schedule kept, revocation in
 * the schedule's transaction, the 24-hour export window), an object store that records, a
 * recording emitter and jobs, and the API assembled on the real plugin stack: request context,
 * error handler, B017's auth plugin over the in-memory token service, and B024's idempotency
 * plugin.
 */
import { createHash } from 'node:crypto';
import { newId } from '@centcom/contracts';
import { type AuditEvent } from '@centcom/core';
import type { User } from '@centcom/db';
import { fastify, type FastifyInstance } from 'fastify';
import type { Transaction } from 'kysely';
import {
  AccountLifecycleService,
  accountLifecycleRoutes,
  type AccountJobs,
  type AccountLifecycleAction,
  type AccountLifecycleServiceDeps,
  type AccountLifecycleStore,
  type ExportBlobStore,
  type ExportData,
  type ExportRow,
  type LifecycleDb,
} from '../../src/modules/account-lifecycle/index.js';
import { authPlugin } from '../../src/plugins/auth.js';
import { errorHandlerPlugin, frameworkErrorHandler } from '../../src/plugins/error-handler.js';
import { idempotencyPlugin } from '../../src/plugins/idempotency.js';
import { requestContextPlugin } from '../../src/plugins/request-context.js';
import { captureLogger, recordingMetrics } from '../helpers.js';
import { memoryTokens, testClock, type TestClock } from '../modules/auth/tokens/helpers.js';
import { userRow } from '../modules/users/helpers.js';

export { DAY_MS, T0 } from '../modules/auth/tokens/helpers.js';

/** A user as the memory store keeps it. */
export type MemoryUser = User & { deletion_scheduled_at: Date | null };

/** The transaction the memory store hands to audit callbacks. */
const MEMORY_TRX = {} as Transaction<LifecycleDb>;

/** The lifecycle store in memory. */
export class MemoryLifecycleStore implements AccountLifecycleStore {
  users = new Map<string, MemoryUser>();
  memberships: { id: string; workspaceId: string; userId: string; role: string }[] = [];
  devices: { id: string; userId: string; revokedAt: Date | null }[] = [];
  /** Users whose refresh tokens the schedule revoked. */
  refreshRevoked = new Set<string>();
  exports = new Map<string, ExportRow>();
  /** What `exportData` returns per user (default: the profile only). */
  data = new Map<string, Partial<ExportData>>();
  /** When set, every call throws it (a database failure). */
  failure: Error | undefined;

  #check(): void {
    if (this.failure !== undefined) throw this.failure;
  }

  addUser(overrides: Partial<MemoryUser> = {}): MemoryUser {
    const user: MemoryUser = { ...userRow(), deletion_scheduled_at: null, ...overrides };
    this.users.set(user.id, user);
    return user;
  }

  join(workspaceId: string, userId: string, role = 'member'): void {
    this.memberships.push({ id: newId('mem'), workspaceId, userId, role });
  }

  #blockers(userId: string): string[] {
    return this.memberships
      .filter((m) => m.userId === userId && m.role === 'owner')
      .map((m) => m.workspaceId)
      .filter(
        (wsp) =>
          !this.memberships.some(
            (o) => o.workspaceId === wsp && o.userId !== userId && o.role === 'owner',
          ) && this.memberships.some((o) => o.workspaceId === wsp && o.userId !== userId),
      );
  }

  #live(userId: string): MemoryUser | undefined {
    const user = this.users.get(userId);
    return user?.status === 'deleted' ? undefined : user;
  }

  async scheduleDeletion(
    userId: string,
    at: Date,
    scheduledFor: Date,
    audit: (trx: Transaction<LifecycleDb>, scheduledFor: Date) => Promise<unknown>,
  ) {
    this.#check();
    const user = this.#live(userId);
    if (user === undefined) return { kind: 'missing' } as const;
    let kind: 'scheduled' | 'already' = 'already';
    if (user.status !== 'pending_deletion' || user.deletion_scheduled_at === null) {
      const blockers = this.#blockers(userId);
      if (blockers.length > 0) return { kind: 'blocked', workspaceIds: blockers } as const;
      await audit(MEMORY_TRX, scheduledFor);
      user.status = 'pending_deletion';
      user.deletion_requested_at = at;
      user.deletion_scheduled_at = scheduledFor;
      kind = 'scheduled';
    }
    this.refreshRevoked.add(userId);
    const revokedDevices: string[] = [];
    for (const d of this.devices) {
      if (d.userId === userId && d.revokedAt === null) {
        d.revokedAt = at;
        revokedDevices.push(d.id);
      }
    }
    return { kind, scheduledFor: user.deletion_scheduled_at ?? scheduledFor, revokedDevices };
  }

  async restore(
    userId: string,
    now: Date,
    audit: (trx: Transaction<LifecycleDb>) => Promise<unknown>,
  ) {
    this.#check();
    const user = this.#live(userId);
    if (user === undefined) return { kind: 'missing' } as const;
    if (user.status !== 'pending_deletion') return { kind: 'not_pending' } as const;
    if (user.deletion_scheduled_at !== null && user.deletion_scheduled_at <= now) {
      return { kind: 'expired' } as const;
    }
    await audit(MEMORY_TRX);
    user.status = 'active';
    user.deletion_requested_at = null;
    user.deletion_scheduled_at = null;
    const plain: User = { ...user };
    delete (plain as Partial<MemoryUser>).deletion_scheduled_at;
    return { kind: 'restored', user: plain } as const;
  }

  cancelDeletion(userId: string): Promise<boolean> {
    this.#check();
    const user = this.#live(userId);
    if (user?.status !== 'pending_deletion') return Promise.resolve(false);
    user.status = 'active';
    user.deletion_requested_at = null;
    user.deletion_scheduled_at = null;
    return Promise.resolve(true);
  }

  async createExport(
    row: { id: string; userId: string; createdAt: Date },
    since: Date,
    audit: (trx: Transaction<LifecycleDb>) => Promise<unknown>,
  ) {
    this.#check();
    if (this.#live(row.userId) === undefined) return { kind: 'missing' } as const;
    const latest = [...this.exports.values()]
      .filter((e) => e.userId === row.userId && e.status !== 'failed' && e.createdAt > since)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    if (latest !== undefined) return { kind: 'limited', latest: latest.createdAt } as const;
    await audit(MEMORY_TRX);
    this.exports.set(row.id, {
      id: row.id,
      userId: row.userId,
      status: 'pending',
      blobKey: null,
      sizeBytes: null,
      errorCode: null,
      createdAt: row.createdAt,
      expiresAt: null,
    });
    return { kind: 'created' } as const;
  }

  getExport(userId: string, exportId: string): Promise<ExportRow | null> {
    this.#check();
    const row = this.exports.get(exportId);
    return Promise.resolve(row?.userId === userId ? { ...row } : null);
  }

  claimExport(exportId: string): Promise<ExportRow | null> {
    this.#check();
    const row = this.exports.get(exportId);
    if (row === undefined || (row.status !== 'pending' && row.status !== 'running')) {
      return Promise.resolve(null);
    }
    row.status = 'running';
    return Promise.resolve({ ...row });
  }

  exportData(userId: string): Promise<ExportData | null> {
    this.#check();
    const user = this.#live(userId);
    if (user === undefined) return Promise.resolve(null);
    return Promise.resolve({
      user,
      devices: [],
      memberships: [],
      apiKeys: [],
      notificationPreferences: null,
      auditEvents: [],
      ...this.data.get(userId),
    });
  }

  markReady(exportId: string, blobKey: string, sizeBytes: number, expiresAt: Date) {
    const row = this.exports.get(exportId);
    if (row !== undefined && (row.status === 'pending' || row.status === 'running')) {
      Object.assign(row, { status: 'ready', blobKey, sizeBytes, expiresAt, errorCode: null });
    }
    return Promise.resolve();
  }

  markFailed(exportId: string, errorCode: string) {
    const row = this.exports.get(exportId);
    if (row !== undefined && (row.status === 'pending' || row.status === 'running')) {
      Object.assign(row, { status: 'failed', errorCode });
    }
    return Promise.resolve();
  }

  dueForExpiry(now: Date, limit: number): Promise<ExportRow[]> {
    return Promise.resolve(
      [...this.exports.values()]
        .filter((e) => e.status === 'ready' && e.expiresAt !== null && e.expiresAt <= now)
        .slice(0, limit)
        .map((e) => ({ ...e })),
    );
  }

  markExpired(exportId: string) {
    const row = this.exports.get(exportId);
    if (row?.status === 'ready') row.status = 'expired';
    return Promise.resolve();
  }

  stalePending(before: Date, limit: number): Promise<string[]> {
    return Promise.resolve(
      [...this.exports.values()]
        .filter((e) => e.status === 'pending' && e.createdAt < before)
        .slice(0, limit)
        .map((e) => e.id),
    );
  }
}

/** An object store in memory that records what it is asked, with signed-looking URLs. */
export function memoryBlobStore() {
  const objects = new Map<string, Uint8Array>();
  const presigned: { key: string; ttlS: number; now: Date }[] = [];
  const state = { failPuts: 0, deletes: [] as string[] };
  const store: ExportBlobStore = {
    put(key, body) {
      if (state.failPuts > 0) {
        state.failPuts -= 1;
        return Promise.reject(new Error('store down'));
      }
      objects.set(key, body);
      return Promise.resolve();
    },
    delete(key) {
      state.deletes.push(key);
      objects.delete(key);
      return Promise.resolve();
    },
    presignGet(key, ttlS, now) {
      presigned.push({ key, ttlS, now });
      const expires = Math.floor(now.getTime() / 1000) + ttlS;
      const sig = createHash('sha256').update(`${key}:${expires}`).digest('hex');
      return `https://objects.test/bucket/${key}?X-Amz-Expires=${ttlS}&expires=${expires}&sig=${sig}`;
    },
  };
  return { store, objects, presigned, state };
}

/** Jobs that record what they are asked. */
export function recordingJobs() {
  const calls = {
    exports: [] as string[],
    purges: [] as { userId: string; at: Date }[],
    cancels: [] as string[],
  };
  const state = { fail: false };
  const fail = () => (state.fail ? Promise.reject(new Error('redis down')) : Promise.resolve());
  const jobs: AccountJobs = {
    enqueueExport: (id) => fail().then(() => void calls.exports.push(id)),
    schedulePurge: (userId, at) => fail().then(() => void calls.purges.push({ userId, at })),
    cancelPurge: (userId) => fail().then(() => void calls.cancels.push(userId)),
  };
  return { jobs, calls, state };
}

/** An emitter that records the events it is given. */
export function recordingEmitter() {
  const events: AuditEvent<AccountLifecycleAction>[] = [];
  return {
    events,
    emit: (_trx: unknown, event: AuditEvent<AccountLifecycleAction>) => {
      events.push(event);
      return Promise.resolve(newId('aud'));
    },
  };
}

/** The account lifecycle API over in-memory stores. */
export async function lifecycleApp(
  overrides: Partial<AccountLifecycleServiceDeps> & { clock?: TestClock } = {},
) {
  const captured = captureLogger();
  const recorded = recordingMetrics();
  const clock = overrides.clock ?? testClock();
  const { tokens, store: refresh, redis } = memoryTokens({ clock });
  const store = new MemoryLifecycleStore();
  const blobs = memoryBlobStore();
  const jobs = recordingJobs();
  const emitter = recordingEmitter();
  const service = new AccountLifecycleService({
    store,
    emitter,
    tokens,
    jobs: jobs.jobs,
    blobs: blobs.store,
    clock: clock.now,
    logger: captured.logger,
    metrics: recorded.metrics,
    ...overrides,
  });
  tokens.registerPrincipalResolver('cen_', () =>
    Promise.resolve({
      kind: 'api_key',
      userId: null,
      deviceId: null,
      workspaceId: newId('wsp'),
      scopes: ['profile'],
    }),
  );
  const app: FastifyInstance = fastify({
    logger: false,
    frameworkErrors: frameworkErrorHandler({ logger: captured.logger }),
  });
  await app.register(requestContextPlugin, { logger: captured.logger });
  await app.register(errorHandlerPlugin, { logger: captured.logger });
  await app.register(authPlugin, { tokens });
  await app.register(idempotencyPlugin, {
    kv: redis.kv,
    clock: clock.now,
    principal: (request) => request.principal?.userId ?? request.principal?.keyId ?? null,
  });
  await app.register(accountLifecycleRoutes, { service });
  await app.ready();

  /** A user with a live device, known to the token service and the store. */
  const addUser = (overrides: Partial<MemoryUser> = {}) => {
    const user = store.addUser(overrides);
    const deviceId = addDevice(user.id);
    return { user, deviceId };
  };
  /** Another live device of `userId`. */
  const addDevice = (userId: string): string => {
    const deviceId = newId('dev');
    store.devices.push({ id: deviceId, userId, revokedAt: null });
    refresh.devices.set(deviceId, { userId, revoked: false });
    return deviceId;
  };
  /** Tokens for `userId` on `deviceId`. */
  const signIn = (userId: string, deviceId: string | null, scopes: string[] = ['profile']) =>
    tokens.issueTokens({ userId, deviceId, scopes });

  return {
    app,
    service,
    store,
    tokens,
    refresh,
    redis,
    clock,
    blobs,
    jobs,
    emitter,
    captured,
    recorded,
    addUser,
    addDevice,
    signIn,
  };
}

/** A bearer header, with an Idempotency-Key when given. */
export const bearer = (token: string, idempotencyKey?: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
});
