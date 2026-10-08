/**
 * Test helpers for the token service (B017): key sets, a clock the test moves, an in-memory
 * refresh store with the same rules as the Postgres one (it decides with `decideRotation`), the
 * API assembled with the auth plugin and routes, and seed rows for the real-Postgres tests.
 */
import { randomBytes } from 'node:crypto';
import { createMemoryRedis, type Logger, type Metrics, type RedisBackend } from '@centcom/core';
import type { CoreDatabase, TokenDatabase } from '@centcom/db';
import { fastify, type FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import {
  decideRotation,
  generateSigningJwk,
  hashRefreshToken,
  invalidRefreshToken,
  newRefreshToken,
  refreshRevokedByStaff,
  parseSigningKeys,
  REFRESH_ABSOLUTE_MS,
  REFRESH_SLIDING_MS,
  REFRESH_TOKEN_SHAPE,
  refreshReuseDetected,
  TokenService,
  type RefreshGrant,
  type RefreshStore,
  type TokenKeys,
  type TokenServiceDeps,
} from '../../../../src/modules/auth/tokens/index.js';
import { authPlugin } from '../../../../src/plugins/auth.js';
import {
  errorHandlerPlugin,
  frameworkErrorHandler,
} from '../../../../src/plugins/error-handler.js';
import { requestContextPlugin } from '../../../../src/plugins/request-context.js';
import { revokeRoutes } from '../../../../src/routes/auth/revoke.js';
import { tokenRoutes } from '../../../../src/routes/auth/token.js';
import { wellKnownRoutes } from '../../../../src/routes/well-known.js';
import { captureLogger } from '../../../helpers.js';
import { newId, scriptedDb } from '../../users/helpers.js';

export { newId };

/** The tests' epoch: 2026-10-07T12:00:00Z. */
export const T0 = Date.parse('2026-10-07T12:00:00.000Z');
export const DAY_MS = 24 * 60 * 60 * 1000;

/** A clock the test moves. */
export interface TestClock {
  now: () => number;
  advance(ms: number): void;
}

export function testClock(start = T0): TestClock {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

type PrivateJwk = ReturnType<typeof generateSigningJwk>;
/** The public half of a JWK (as published once its private part is retired). */
export const publicOnly = ({ kty, crv, kid, x }: PrivateJwk): Omit<PrivateJwk, 'd'> => ({
  kty,
  crv,
  kid,
  x,
});

/** A key set from JWKs; `active` names the signer. */
export const keySet = (jwks: readonly object[], active: string): TokenKeys =>
  parseSigningKeys(JSON.stringify(jwks), active);

/** One fresh signing key, `k1`. */
export const singleKey = (): TokenKeys => keySet([generateSigningJwk('k1')], 'k1');

interface MemoryRow {
  familyId: string;
  grant: RefreshGrant;
  usedAt: number | null;
  revokedAt: number | null;
  /** `staff` when staff revoked it (B087). */
  revokedReason?: 'staff';
  expiresAt: number;
  absoluteExpiresAt: number;
}

/** A refresh store in memory, by the Postgres store's rules; `devices` holds the device records. */
export function memoryRefreshStore(
  now: () => number,
  devices = new Map<string, { userId: string; revoked: boolean }>(),
): RefreshStore & { rows: Map<string, MemoryRow>; devices: typeof devices } {
  const rows = new Map<string, MemoryRow>();
  const revokeFamily = (familyId: string): void => {
    for (const row of rows.values())
      if (row.familyId === familyId && row.revokedAt === null) row.revokedAt = now();
  };
  return {
    rows,
    devices,
    issue(grant) {
      const { token, hash } = newRefreshToken();
      const at = now();
      rows.set(hash, {
        familyId: randomBytes(16).toString('hex'),
        grant: { ...grant },
        usedAt: null,
        revokedAt: null,
        expiresAt: at + REFRESH_SLIDING_MS,
        absoluteExpiresAt: at + REFRESH_ABSOLUTE_MS,
      });
      return Promise.resolve(token);
    },
    rotate(token, clientId, onReuse) {
      if (!REFRESH_TOKEN_SHAPE.test(token)) return Promise.reject(invalidRefreshToken());
      const hash = hashRefreshToken(token);
      const row = rows.get(hash);
      const deviceId = row?.grant.deviceId ?? null;
      const device = deviceId === null ? undefined : devices.get(deviceId);
      const at = now();
      const decision = decideRotation(
        row === undefined
          ? undefined
          : {
              revoked_at: row.revokedAt === null ? null : new Date(row.revokedAt),
              revoked_reason: row.revokedReason ?? null,
              used_at: row.usedAt === null ? null : new Date(row.usedAt),
              client_id: row.grant.clientId,
              expires_at: new Date(row.expiresAt),
              absolute_expires_at: new Date(row.absoluteExpiresAt),
            },
        {
          nowMs: at,
          clientId,
          deviceRevoked: deviceId !== null && (device === undefined || device.revoked),
        },
      );
      if (row === undefined || decision === 'invalid') return Promise.reject(invalidRefreshToken());
      if (decision === 'revoked') return Promise.reject(refreshRevokedByStaff());
      if (decision === 'reuse') {
        revokeFamily(row.familyId);
        onReuse?.(row.familyId);
        return Promise.reject(refreshReuseDetected());
      }
      row.usedAt = at;
      const next = newRefreshToken();
      rows.set(next.hash, {
        ...row,
        usedAt: null,
        expiresAt: Math.min(at + REFRESH_SLIDING_MS, row.absoluteExpiresAt),
      });
      return Promise.resolve({
        token: next.token,
        grant: { ...row.grant },
        familyId: row.familyId,
      });
    },
    revokeFamily(familyId) {
      revokeFamily(familyId);
      return Promise.resolve();
    },
    revokeByToken(token, userId) {
      const row = rows.get(hashRefreshToken(token));
      if (row === undefined || row.grant.userId !== userId) return Promise.resolve(false);
      revokeFamily(row.familyId);
      return Promise.resolve(true);
    },
    revokeDevice(deviceId) {
      const device = devices.get(deviceId);
      if (device !== undefined) device.revoked = true;
      for (const row of rows.values())
        if (row.grant.deviceId === deviceId && row.revokedAt === null) row.revokedAt = now();
      return Promise.resolve();
    },
    revokeUser(userId) {
      let revoked = 0;
      for (const row of rows.values()) {
        if (row.grant.userId !== userId || row.revokedAt !== null) continue;
        row.revokedAt = now();
        row.revokedReason = 'staff';
        revoked += 1;
      }
      return Promise.resolve(revoked);
    },
    device(deviceId) {
      const device = devices.get(deviceId);
      return Promise.resolve(device === undefined ? undefined : { ...device });
    },
  };
}

/** A token service on an in-memory store and Redis, unless `deps` says otherwise. */
export function memoryTokens(overrides: Partial<TokenServiceDeps> & { clock?: TestClock } = {}): {
  tokens: TokenService;
  store: ReturnType<typeof memoryRefreshStore>;
  redis: RedisBackend;
  clock: TestClock;
  keys: TokenKeys;
} {
  const clock = overrides.clock ?? testClock();
  const store = memoryRefreshStore(clock.now);
  const redis = createMemoryRedis(clock.now);
  const keys = overrides.keys ?? singleKey();
  const tokens = new TokenService({
    db: scriptedDb().db as unknown as Kysely<TokenDatabase>,
    keys,
    kv: redis.kv,
    store,
    now: clock.now,
    ...overrides,
  });
  return { tokens, store, redis, clock, keys };
}

/** A user with a live device, registered in the in-memory store. */
export function memoryUser(store: ReturnType<typeof memoryRefreshStore>): {
  userId: string;
  deviceId: string;
} {
  const userId = newId('usr');
  const deviceId = newId('dev');
  store.devices.set(deviceId, { userId, revoked: false });
  return { userId, deviceId };
}

/**
 * The API as it will run: request context, error handler, auth plugin, the token, revoke and JWKS
 * routes, and three test routes: `/v1/test/me` (any principal), `/v1/test/admin` (scope `admin`)
 * and `/v1/test/public` (no authentication).
 */
export async function authApp(
  tokens: TokenService,
  opts: { metrics?: Metrics; captured?: ReturnType<typeof captureLogger> } = {},
): Promise<{
  app: FastifyInstance;
  logger: Logger;
  raw: () => string;
  lines: () => Record<string, unknown>[];
}> {
  const captured = opts.captured ?? captureLogger();
  const app = fastify({
    logger: false,
    frameworkErrors: frameworkErrorHandler({ logger: captured.logger }),
  });
  await app.register(requestContextPlugin, {
    logger: captured.logger,
    ...(opts.metrics === undefined ? {} : { metrics: opts.metrics }),
  });
  await app.register(errorHandlerPlugin, { logger: captured.logger });
  await app.register(authPlugin, { tokens });
  await app.register(tokenRoutes, { tokens });
  await app.register(revokeRoutes, { tokens });
  await app.register(wellKnownRoutes, { tokens });
  app.get('/v1/test/me', async (request) => {
    const principal = request.principal;
    if (principal === null) return null;
    const { kind, userId, deviceId, workspaceId, scopes } = principal;
    return { kind, userId, deviceId, workspaceId, scopes };
  });
  app.get('/v1/test/admin', { config: { auth: { scopes: ['admin'] } } }, async () => ({
    ok: true,
  }));
  app.get('/v1/test/public', { config: { auth: false } }, async (request) => ({
    principal: request.principal,
  }));
  await app.ready();
  return { app, logger: captured.logger, raw: captured.raw, lines: captured.lines };
}

/** A bearer header. */
export const bearer = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
});

/** A user and a live device in a real database (rows that satisfy B008's checks). */
export async function seedUser(
  db: Kysely<CoreDatabase>,
): Promise<{ userId: string; deviceId: string }> {
  const userId = newId('usr');
  const deviceId = newId('dev');
  await db
    .insertInto('users')
    .values({
      id: userId,
      email: `${userId.toLowerCase()}@example.test`,
      display_name: 'Token Tester',
    })
    .execute();
  await db
    .insertInto('devices')
    .values({
      id: deviceId,
      user_id: userId,
      name: 'Test device',
      platform: 'linux',
      x25519_pub: randomBytes(32).toString('base64url'),
      ed25519_pub: randomBytes(32).toString('base64url'),
      fingerprint: 'ABCD-EFGH-JKLM',
    })
    .execute();
  return { userId, deviceId };
}
