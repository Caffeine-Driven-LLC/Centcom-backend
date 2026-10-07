/**
 * Test helpers for `/v1/me` (B022): an in-memory AccountStore with the Postgres one's semantics
 * (compare-and-set on the version, deleted users invisible, membership and personal workspace),
 * a header-driven caller standing in for the B017 auth plugin (`authorization: Bearer <user>`,
 * `Bearer expired`, `Bearer invalid`, `x-test-scopes`, `x-test-wsp`, `x-test-kind: api_key`), and
 * the routes on the API's plugin stack.
 */
import { createIdGenerator } from '@centcom/contracts';
import { AppError } from '@centcom/core';
import type { ProfilePatch, User } from '@centcom/db';
import { fastify, type FastifyInstance, type FastifyRequest } from 'fastify';
import type { EntitlementsLookup } from '../../src/modules/me/entitlements-lookup.js';
import {
  MeService,
  type AccountAuditSink,
  type AccountStore,
  type AccountUpdatedEvent,
  type UpdateOutcome,
  type VersionedUser,
} from '../../src/modules/me/service.js';
import { errorHandlerPlugin } from '../../src/plugins/error-handler.js';
import { requestContextPlugin } from '../../src/plugins/request-context.js';
import { meRoutes, type Caller } from '../../src/routes/me.js';
import { captureLogger } from '../helpers.js';

export const newId = createIdGenerator();
export const T0 = Date.parse('2026-10-07T12:00:00.000Z');

/** A user row as B013 makes it. */
export function userRow(overrides: Partial<User> = {}): User {
  const id = overrides.id ?? newId('usr');
  return {
    id,
    email: `${id.toLowerCase()}@example.test`,
    display_name: 'Ada',
    locale: 'en',
    avatar_slot: null,
    telemetry_opt_in: false,
    status: 'active',
    deletion_requested_at: null,
    created_at: new Date(T0),
    updated_at: new Date(T0),
    ...overrides,
  };
}

/** Accounts in memory: versions are microseconds of a clock that ticks on every write. */
export function memoryAccounts(): AccountStore & {
  users: Map<string, VersionedUser>;
  memberships: Set<string>;
  personal: Map<string, string>;
  failWith?: Error;
  /** Runs before the compare-and-set: lets a test slip another write in between. */
  beforeUpdate?: () => Promise<void>;
} {
  let micros = BigInt(T0) * 1000n;
  const tick = (): string => String((micros += 1000n));
  const store: ReturnType<typeof memoryAccounts> = {
    users: new Map(),
    memberships: new Set(),
    personal: new Map(),
    find(userId) {
      if (store.failWith !== undefined) return Promise.reject(store.failWith);
      const found = store.users.get(userId);
      return Promise.resolve(
        found === undefined || found.user.status === 'deleted'
          ? null
          : { user: { ...found.user }, version: found.version },
      );
    },
    async update(userId, patch: ProfilePatch, versions): Promise<UpdateOutcome> {
      if (store.failWith !== undefined) throw store.failWith;
      await store.beforeUpdate?.();
      const found = store.users.get(userId);
      if (found === undefined || found.user.status === 'deleted') return { kind: 'missing' };
      if (versions !== undefined && !versions.includes(found.version)) return { kind: 'stale' };
      const updated: VersionedUser = {
        user: { ...found.user, ...patch, updated_at: new Date() },
        version: tick(),
      };
      store.users.set(userId, updated);
      return { kind: 'updated', user: { user: { ...updated.user }, version: updated.version } };
    },
    isMember: (userId, workspaceId) =>
      Promise.resolve(store.memberships.has(`${userId}|${workspaceId}`)),
    personalWorkspace: (userId) => Promise.resolve(store.personal.get(userId) ?? null),
  };
  return store;
}

/** Adds a user (version = the first tick) and returns it. */
export function addUser(
  store: ReturnType<typeof memoryAccounts>,
  overrides: Partial<User> = {},
): VersionedUser {
  const user = userRow(overrides);
  const entry = { user, version: String(BigInt(T0) * 1000n) };
  store.users.set(user.id, entry);
  return entry;
}

/** The B017 stand-in: who calls, from headers; `Bearer expired` and `Bearer invalid` are the 401s. */
export function headerCaller(request: FastifyRequest): Caller | null {
  const auth = request.headers.authorization;
  if (auth === undefined) return null;
  const token = auth.replace(/^Bearer /, '');
  if (token === 'expired')
    throw new AppError('token_expired', { detail: 'The access token has expired.' });
  if (token === 'invalid')
    throw new AppError('token_invalid', { detail: 'The access token is not valid.' });
  const scopes = String(request.headers['x-test-scopes'] ?? 'profile')
    .split(' ')
    .filter(Boolean);
  if (request.headers['x-test-kind'] === 'api_key') return { kind: 'api_key', scopes };
  const wsp = request.headers['x-test-wsp'];
  return {
    kind: 'user',
    userId: token,
    scopes,
    ...(typeof wsp === 'string' ? { workspaceId: wsp } : {}),
  };
}

/** A recording audit sink. */
export function recordingAudit(): AccountAuditSink & {
  events: AccountUpdatedEvent[];
  fail: boolean;
} {
  const sink = {
    events: [] as AccountUpdatedEvent[],
    fail: false,
    record(event: AccountUpdatedEvent): Promise<void> {
      if (sink.fail) return Promise.reject(new Error('audit down'));
      sink.events.push(event);
      return Promise.resolve();
    },
  };
  return sink;
}

/** The routes over `store`, with an entitlements stub at revision 7 unless told otherwise. */
export async function meApp(
  store: AccountStore,
  opts: { entitlements?: EntitlementsLookup; audit?: ReturnType<typeof recordingAudit> } = {},
): Promise<{
  app: FastifyInstance;
  audit: ReturnType<typeof recordingAudit>;
  lines: () => Record<string, unknown>[];
  raw: () => string;
}> {
  const captured = captureLogger();
  const audit = opts.audit ?? recordingAudit();
  const me = new MeService({
    store,
    audit,
    entitlements: opts.entitlements ?? {
      forUser: () => Promise.resolve({ plan: 'pro', status: 'active', rev: 7 }),
    },
    logger: captured.logger,
    now: () => T0,
  });
  const app = fastify({ logger: false });
  await app.register(requestContextPlugin, { logger: captured.logger });
  await app.register(errorHandlerPlugin, { logger: captured.logger });
  await app.register(meRoutes, { me, caller: headerCaller });
  await app.ready();
  return { app, audit, lines: captured.lines, raw: captured.raw };
}

/** Headers of a user's request. */
export const as = (userId: string, extra: Record<string, string> = {}): Record<string, string> => ({
  authorization: `Bearer ${userId}`,
  ...extra,
});
