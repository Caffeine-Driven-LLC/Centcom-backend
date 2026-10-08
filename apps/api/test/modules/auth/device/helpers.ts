/**
 * Test helpers for the device flow (B016): an in-memory grant store with the Postgres store's
 * rules (it decides with `decidePoll`, creates the device only when `issue` succeeds), the API
 * with the token and device routes, valid and invalid public keys, and a terminal that polls.
 */
import { randomBytes } from 'node:crypto';
import { newId } from '@centcom/contracts';
import type { RedisBackend } from '@centcom/core';
import type { FastifyInstance } from 'fastify';
import { fastify } from 'fastify';
import { deviceRoutes } from '../../../../src/modules/auth/device/routes.js';
import { registerDeviceGrant } from '../../../../src/modules/auth/device/grant-handler.js';
import {
  DeviceGrantService,
  type DeviceGrantServiceDeps,
} from '../../../../src/modules/auth/device/service.js';
import {
  decidePoll,
  slowerInterval,
  type DeviceGrantRecord,
  type DeviceGrantStore,
} from '../../../../src/modules/auth/device/store.js';
import { deviceFingerprint } from '../../../../src/modules/auth/device/keys.js';
import { authPlugin } from '../../../../src/plugins/auth.js';
import {
  errorHandlerPlugin,
  frameworkErrorHandler,
} from '../../../../src/plugins/error-handler.js';
import { requestContextPlugin } from '../../../../src/plugins/request-context.js';
import { tokenRoutes } from '../../../../src/routes/auth/token.js';
import type { TokenService } from '../../../../src/modules/auth/tokens/index.js';
import { captureLogger } from '../../../helpers.js';
import { memoryTokens, type TestClock } from '../tokens/helpers.js';

export { T0, testClock } from '../tokens/helpers.js';

/** A device row the in-memory store created. */
export interface MemoryDevice {
  id: string;
  userId: string;
  name: string;
  platform: string;
  x25519Pub: string;
  ed25519Pub: string;
  fingerprint: string;
}

/** Device grants in memory, by the Postgres store's rules. */
export function memoryGrantStore(
  refreshDevices: Map<string, { userId: string; revoked: boolean }>,
): DeviceGrantStore & { rows: Map<string, DeviceGrantRecord>; devices: Map<string, MemoryDevice> } {
  const rows = new Map<string, DeviceGrantRecord>();
  const devices = new Map<string, MemoryDevice>();
  const pendingWith = (userCode: string, now: Date) =>
    [...rows.values()].find(
      (row) =>
        row.userCode === userCode &&
        row.status === 'pending' &&
        row.expiresAt.getTime() > now.getTime(),
    );
  return {
    rows,
    devices,
    insert(grant) {
      if ([...rows.values()].some((r) => r.userCode === grant.userCode && r.status === 'pending')) {
        return Promise.resolve('user_code_taken');
      }
      rows.set(grant.deviceCodeHash, {
        ...grant,
        status: 'pending',
        userId: null,
        deviceId: null,
        lastPolledAt: null,
      });
      return Promise.resolve('inserted');
    },
    findPending(userCode, now) {
      const row = pendingWith(userCode, now);
      return Promise.resolve(row === undefined ? null : { ...row });
    },
    decide(userCode, userId, status, now) {
      const row = pendingWith(userCode, now);
      if (row === undefined) return Promise.resolve(false);
      row.status = status;
      row.userId = userId;
      return Promise.resolve(true);
    },
    async poll(deviceCodeHash, clientId, now, issue) {
      const row = rows.get(deviceCodeHash);
      const decision = decidePoll(row, { now, clientId });
      if (row === undefined || decision === 'expired') return { kind: 'expired' };
      if (decision === 'denied') return { kind: 'denied' };
      if (decision === 'slow_down' || decision === 'pending') {
        if (decision === 'slow_down') row.intervalS = slowerInterval(row.intervalS);
        row.lastPolledAt = now;
        return { kind: decision, intervalS: row.intervalS };
      }
      const userId = row.userId as string;
      const deviceId = newId('dev');
      const device: MemoryDevice = {
        id: deviceId,
        userId,
        name: row.deviceName,
        platform: row.platform,
        x25519Pub: row.x25519Pub,
        ed25519Pub: row.ed25519Pub,
        fingerprint: deviceFingerprint({ x25519: row.x25519Pub, ed25519: row.ed25519Pub }),
      };
      devices.set(deviceId, device);
      refreshDevices.set(deviceId, { userId, revoked: false });
      try {
        const result = await issue(
          { deviceId, userId, clientId: row.clientId, scope: row.scope },
          undefined,
        );
        row.status = 'consumed';
        row.deviceId = deviceId;
        row.lastPolledAt = now;
        return { kind: 'issued', result };
      } catch (err) {
        // As the transaction's rollback would.
        devices.delete(deviceId);
        refreshDevices.delete(deviceId);
        throw err;
      }
    },
  };
}

/** Two valid 32-byte public keys. */
export const validKeys = (): { x25519: string; ed25519: string } => ({
  x25519: randomBytes(32).toString('base64url'),
  ed25519: randomBytes(32).toString('base64url'),
});

/** A valid `POST /v1/auth/device/code` body. */
export const startBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  client_id: 'centcom-cli',
  device_name: 'build-box',
  device_pubkeys: validKeys(),
  ...overrides,
});

/** The User-Agent of CT-VER, on Linux. */
export const CLI_USER_AGENT = 'centcom-cli/1.4.2 (contract/1.0.0; linux-x64; node/22.9.0)';

/** Everything a flow test needs: the API, its parts and the clock. */
export interface DeviceHarness {
  app: FastifyInstance;
  service: DeviceGrantService;
  store: ReturnType<typeof memoryGrantStore>;
  tokens: TokenService;
  refresh: ReturnType<typeof memoryTokens>['store'];
  redis: RedisBackend;
  clock: TestClock;
  logs: () => string;
  /** `POST /v1/auth/device/code` as the CLI. */
  start(body?: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }>;
  /** `POST /v1/auth/token` with the device_code grant, form-encoded as RFC 8628 says. */
  poll(
    deviceCode: string,
    clientId?: string,
  ): Promise<{ status: number; body: Record<string, unknown>; headers: Record<string, unknown> }>;
}

/** The API with the auth plugin, the token endpoint and the device routes, on in-memory stores. */
export async function deviceHarness(
  opts: { service?: Partial<DeviceGrantServiceDeps>; store?: DeviceGrantStore } = {},
): Promise<DeviceHarness> {
  const { tokens, store: refresh, redis, clock } = memoryTokens();
  const store = memoryGrantStore(refresh.devices);
  const captured = captureLogger();
  const service = new DeviceGrantService({
    store: opts.store ?? store,
    kv: redis.kv,
    now: clock.now,
    logger: captured.logger,
    ...opts.service,
  });
  registerDeviceGrant(tokens, opts.store ?? store, clock.now);
  const app = fastify({
    logger: false,
    frameworkErrors: frameworkErrorHandler({ logger: captured.logger }),
  });
  await app.register(requestContextPlugin, { logger: captured.logger });
  await app.register(errorHandlerPlugin, { logger: captured.logger });
  await app.register(authPlugin, { tokens });
  await app.register(tokenRoutes, { tokens });
  await app.register(deviceRoutes, { devices: service });
  await app.ready();
  return {
    app,
    service,
    store,
    tokens,
    refresh,
    redis,
    clock,
    logs: captured.raw,
    async start(body = startBody()) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/device/code',
        headers: { 'user-agent': CLI_USER_AGENT },
        payload: body,
      });
      return { status: res.statusCode, body: res.json() };
    },
    async poll(deviceCode, clientId = 'centcom-cli') {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/token',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceCode,
          client_id: clientId,
        }).toString(),
      });
      return { status: res.statusCode, body: res.json(), headers: res.headers };
    },
  };
}

/** A user id for the person at the browser. */
export const someUser = (): string => newId('usr');

/** The claims of a JWT, unverified (the tests check them after the service verified it). */
export const claimsOf = (jwt: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
