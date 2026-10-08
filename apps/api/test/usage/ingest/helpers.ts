/**
 * Fixtures for the usage tests (B074): an in-memory repository with the Postgres one's rules
 * (dedupe by workspace and event id, attribution lookups), event and batch builders, and the route
 * on the real plugin stack: request context, error handler, rate limiter (B023, the device from a
 * test header), auth (B017, device tokens), idempotency (B024, in-memory KeyValue).
 */
import { randomUUID } from 'node:crypto';
import { newId } from '@centcom/contracts';
import {
  createMemoryRedis,
  defaultBuckets,
  type KeyValue,
  type RateLimitPrincipal,
} from '@centcom/core';
import { fastify } from 'fastify';
import { UsageIngest, type UsageIngestDeps } from '../../../src/modules/usage/ingest.js';
import type { UsageRepository, UsageRow } from '../../../src/modules/usage/repository.js';
import { authPlugin } from '../../../src/plugins/auth.js';
import { errorHandlerPlugin } from '../../../src/plugins/error-handler.js';
import { idempotencyPlugin } from '../../../src/plugins/idempotency.js';
import { rateLimitPlugin } from '../../../src/plugins/rate-limit.js';
import { requestContextPlugin } from '../../../src/plugins/request-context.js';
import { usageRoutes } from '../../../src/routes/usage/index.js';
import { captureLogger } from '../../helpers.js';
import { memoryTokens, memoryUser, T0, testClock } from '../../modules/auth/tokens/helpers.js';

export { newId, T0 };

/** A session as the memory repository knows it. */
export interface MemorySession {
  workspaceId: string | null;
  createdBy: string;
  members: string[];
}

/** The in-memory repository, by the Postgres one's rules. */
export function memoryUsage() {
  const rows = new Map<string, UsageRow>();
  const sessions = new Map<string, MemorySession>();
  const memberships = new Set<string>();
  const personal = new Map<string, string>();
  let fail: (() => Error | undefined) | undefined;
  const repository: UsageRepository = {
    insertEvents: (batch) =>
      new Promise((resolve, reject) => {
        // A turn of the event loop, so concurrent requests interleave.
        setImmediate(() => {
          const error = fail?.();
          if (error !== undefined) return reject(error);
          const inserted: string[] = [];
          for (const row of batch) {
            const key = `${row.workspaceId}/${row.eventId}`;
            if (rows.has(key)) continue;
            rows.set(key, row);
            inserted.push(row.workspaceId);
          }
          resolve(inserted);
        });
      }),
    sessionAccess: (sessionId, userId) => {
      const s = sessions.get(sessionId);
      return Promise.resolve(
        s === undefined
          ? null
          : {
              workspaceId: s.workspaceId,
              participant: s.createdBy === userId || s.members.includes(userId),
            },
      );
    },
    isMember: (userId, workspaceId) => Promise.resolve(memberships.has(`${userId}/${workspaceId}`)),
    personalWorkspace: (userId) => Promise.resolve(personal.get(userId) ?? null),
  };
  return {
    repository,
    rows,
    sessions,
    /** Makes `userId` a member of `workspaceId`. */
    join: (userId: string, workspaceId: string) => memberships.add(`${userId}/${workspaceId}`),
    /** Gives `userId` a personal workspace; returns it. */
    personal: (userId: string, workspaceId = newId('wsp')) => {
      personal.set(userId, workspaceId);
      memberships.add(`${userId}/${workspaceId}`);
      return workspaceId;
    },
    failWith: (f: () => Error | undefined) => {
      fail = f;
    },
  };
}

/** A valid event at `at` (default a minute before T0). */
export function usageEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: newId('use'),
    type: 'tokens_in',
    qty: 1200,
    at: new Date(T0 - 60_000).toISOString(),
    ...overrides,
  };
}

/** `count` valid events. */
export const usageEvents = (count: number, overrides: Record<string, unknown> = {}) =>
  Array.from({ length: count }, () => usageEvent(overrides));

/** The route over `memory` on the real plugin stack, with a clock at T0. */
export async function usageApp(
  memory = memoryUsage(),
  opts: { kv?: KeyValue; deps?: Partial<UsageIngestDeps> } = {},
) {
  const clock = testClock();
  const { tokens, store } = memoryTokens({ clock });
  tokens.registerPrincipalResolver('cen_', () =>
    Promise.resolve({
      kind: 'api_key',
      userId: null,
      deviceId: null,
      workspaceId: newId('wsp'),
      scopes: ['usage:write'],
    }),
  );
  const redis = createMemoryRedis(clock.now);
  const captured = captureLogger();
  const published: { channel: string; message: string }[] = [];
  const ingest = new UsageIngest({
    repository: memory.repository,
    kv: redis.kv,
    pubsub: {
      publish: (channel, message) => {
        published.push({ channel, message });
        return Promise.resolve();
      },
    },
    clock: clock.now,
    logger: captured.logger,
    ...opts.deps,
  });
  const app = fastify({ logger: false });
  await app.register(requestContextPlugin, { logger: captured.logger });
  await app.register(errorHandlerPlugin, { logger: captured.logger });
  await app.register(rateLimitPlugin, {
    store: redis.rateLimit,
    clock: clock.now,
    config: { buckets: defaultBuckets, trustedHops: 0, exempt: [] },
    principal: (request): RateLimitPrincipal | null => {
      const user = request.headers['x-test-user'];
      const device = request.headers['x-test-device'];
      return typeof user === 'string'
        ? {
            kind: 'user',
            userId: user,
            ...(typeof device === 'string' ? { deviceId: device } : {}),
          }
        : null;
    },
  });
  await app.register(authPlugin, { tokens });
  await app.register(idempotencyPlugin, {
    kv: opts.kv ?? redis.kv,
    principal: (request) => request.principal?.userId ?? request.principal?.deviceId ?? null,
  });
  await app.register(usageRoutes, { ingest, clock: clock.now });
  await app.ready();

  /** A device token's headers (with an Idempotency-Key unless `key` is null). */
  const device = async (opts2: { workspaceId?: string; scopes?: string[] } = {}) => {
    const { userId, deviceId } = memoryUser(store);
    const { access_token: token } = await tokens.issueTokens({
      userId,
      deviceId,
      scopes: opts2.scopes ?? ['usage:write'],
      ...(opts2.workspaceId === undefined ? {} : { workspaceId: opts2.workspaceId }),
    });
    const headers = (key: string | null = randomUUID()): Record<string, string> => ({
      authorization: `Bearer ${token}`,
      'x-test-user': userId,
      'x-test-device': deviceId,
      ...(key === null ? {} : { 'idempotency-key': key }),
    });
    return { userId, deviceId, headers };
  };
  /** A token of `userId` without a device (a client that registered none). */
  const deviceless = async (userId: string): Promise<Record<string, string>> => {
    const { access_token: token } = await tokens.issueTokens({
      userId,
      deviceId: null,
      scopes: ['usage:write'],
    });
    return { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() };
  };
  return { app, clock, captured, published, memory, ingest, device, deviceless, redis };
}
