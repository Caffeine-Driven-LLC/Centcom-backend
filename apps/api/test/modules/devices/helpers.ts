/**
 * Test helpers for the device registry (B020): an in-memory device store with the Postgres
 * repository's semantics (owner-only revocation once, the conditional touch, keyset pages, shared
 * sessions), random key pairs, an audit sink that records, and the API assembled with the request
 * context, error handler, B017's auth plugin and token service, and both device route sets. An
 * API key principal (`cen_…`) is registered so machine callers can be tested before B019 lands.
 */
import { randomBytes } from 'node:crypto';
import type { Api } from '@centcom/contracts';
import {
  paginateArray,
  Secret,
  type AuditEvent,
  type PubSub,
  type SigningKeys,
} from '@centcom/core';
import type { DeviceRecord } from '@centcom/db';
import { fastify, type FastifyInstance } from 'fastify';
import type { DeviceStore } from '../../../src/modules/devices/repo.js';
import { DeviceService, type DeviceServiceDeps } from '../../../src/modules/devices/service.js';
import { errorHandlerPlugin, frameworkErrorHandler } from '../../../src/plugins/error-handler.js';
import { authPlugin } from '../../../src/plugins/auth.js';
import { requestContextPlugin } from '../../../src/plugins/request-context.js';
import { authDeviceRoutes } from '../../../src/routes/auth-devices.js';
import { deviceRoutes } from '../../../src/routes/devices.js';
import { tokenRoutes } from '../../../src/routes/auth/token.js';
import { captureLogger } from '../../helpers.js';
import { memoryTokens, newId, type TestClock } from '../auth/tokens/helpers.js';

export { newId };

/** Cursor signing keys for the tests. */
export const KEYS: SigningKeys = [
  { id: 'k1', secret: new Secret(new Uint8Array(randomBytes(32))) },
];

/** A random, valid key, base64url. */
export const randomKey = (): string => randomBytes(32).toString('base64url');

/** A device store in memory, by the Postgres repository's rules. */
export function memoryDeviceStore(now: () => number) {
  const rows = new Map<string, DeviceRecord>();
  const sessions: { sessionId: string; userId: string }[] = [];
  const counts = { touchWrites: 0, touchCalls: 0 };
  let sequence = 0;
  const store: DeviceStore = {
    insert(device) {
      // Each insert is a millisecond later, so `created` orders them.
      sequence += 1;
      const row: DeviceRecord = {
        ...device,
        last_seen_at: null,
        revoked_at: null,
        created_at: new Date(now() + sequence),
      };
      rows.set(row.id, row);
      return Promise.resolve({ ...row });
    },
    findById(id) {
      const row = rows.get(id);
      return Promise.resolve(row === undefined ? null : { ...row });
    },
    listForUser(userId, params) {
      const own = [...rows.values()].filter((row) => row.user_id === userId);
      return Promise.resolve(
        paginateArray(
          own,
          {
            sorts: {
              created: { value: (row) => row.created_at.toISOString(), direction: 'desc' },
            },
            id: (row) => row.id,
          },
          params,
        ),
      );
    },
    markRevoked(id, userId, at) {
      const row = rows.get(id);
      if (row === undefined || row.user_id !== userId || row.revoked_at !== null) {
        return Promise.resolve(false);
      }
      row.revoked_at = at;
      return Promise.resolve(true);
    },
    touch(id, at, minIntervalMs) {
      counts.touchCalls += 1;
      const row = rows.get(id);
      if (
        row === undefined ||
        row.revoked_at !== null ||
        (row.last_seen_at !== null && row.last_seen_at.getTime() > at.getTime() - minIntervalMs)
      ) {
        return Promise.resolve(false);
      }
      row.last_seen_at = at;
      counts.touchWrites += 1;
      return Promise.resolve(true);
    },
    shareSession(userA, userB) {
      const of = (user: string) =>
        new Set(sessions.filter((m) => m.userId === user).map((m) => m.sessionId));
      const b = of(userB);
      return Promise.resolve([...of(userA)].some((session) => b.has(session)));
    },
  };
  /** Puts `users` in one session (a `session_members` row each). */
  const shareASession = (...users: string[]): void => {
    const sessionId = newId('ses');
    for (const userId of users) sessions.push({ sessionId, userId });
  };
  return { store, rows, counts, shareASession };
}

/** An audit sink that records what it is given. */
export function recordingAudit(): { emitDetached(event: AuditEvent): void; events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return { events, emitDetached: (event) => events.push(event) };
}

/** Collects what is published on a channel of `pubsub`. */
export async function listen(pubsub: PubSub, channel: string): Promise<string[]> {
  const seen: string[] = [];
  await pubsub.subscribe(channel, (message) => seen.push(message));
  return seen;
}

/** The registry, the token service and the API, on in-memory stores. */
export async function devicesApp(
  overrides: Partial<DeviceServiceDeps> & { clock?: TestClock } = {},
) {
  const captured = captureLogger();
  const {
    tokens,
    store: refresh,
    redis,
    clock,
  } = memoryTokens(overrides.clock === undefined ? {} : { clock: overrides.clock });
  const memory = memoryDeviceStore(clock.now);
  const audit = recordingAudit();
  const devices = new DeviceService({
    store: memory.store,
    tokens,
    pubsub: redis.pubsub,
    audit,
    logger: captured.logger,
    now: clock.now,
    sleep: () => Promise.resolve(),
    ...overrides,
  });
  tokens.registerPrincipalResolver('cen_', () =>
    Promise.resolve({
      kind: 'api_key',
      userId: null,
      deviceId: null,
      workspaceId: newId('wsp'),
      scopes: ['profile', 'sessions:read'],
    }),
  );

  const app: FastifyInstance = fastify({
    logger: false,
    frameworkErrors: frameworkErrorHandler({ logger: captured.logger }),
  });
  await app.register(requestContextPlugin, { logger: captured.logger });
  await app.register(errorHandlerPlugin, { logger: captured.logger });
  await app.register(authPlugin, { tokens });
  await app.register(tokenRoutes, { tokens });
  await app.register(deviceRoutes, { devices, cursorKeys: KEYS, clock: clock.now });
  await app.register(authDeviceRoutes, { devices, cursorKeys: KEYS, clock: clock.now });
  await app.ready();

  /** A registered device of `userId`, known to the token service too. */
  const addDevice = async (
    userId: string,
    input: Partial<{ name: string; platform: string }> = {},
  ): Promise<Api.Device> => {
    const device = await devices.registerDevice({
      userId,
      name: input.name ?? 'Laptop',
      platform: input.platform ?? 'linux',
      x25519: randomKey(),
      ed25519: randomKey(),
    });
    refresh.devices.set(device.id, { userId, revoked: false });
    return device;
  };

  /** Tokens for `userId` on `deviceId` with `scopes`. */
  const signIn = (
    userId: string,
    deviceId: string | null,
    scopes: string[] = ['profile', 'sessions:read'],
  ) => tokens.issueTokens({ userId, deviceId, scopes });

  return {
    app,
    devices,
    tokens,
    refresh,
    redis,
    clock,
    memory,
    audit,
    captured,
    addDevice,
    signIn,
  };
}

/** A bearer header. */
export const bearer = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
});
