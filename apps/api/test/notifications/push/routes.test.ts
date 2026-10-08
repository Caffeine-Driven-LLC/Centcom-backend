/**
 * `/v1/push/subscriptions` over HTTP (B064 acceptance 1, 2, 3 and 8) on the real auth (B017) and
 * idempotency (B024) plugins, with an in-memory registry of the Postgres one's semantics (the SQL
 * itself is in postgres.test.ts): 201 for each kind, 422 with pointers for an http endpoint,
 * missing keys or a token over 4096 characters, one subscription for a repeated endpoint and for a
 * replayed Idempotency-Key, 409 for an 11th, DELETE 204/404 by owner, 403 for API keys, 401
 * without a token, and no endpoint, token or key in any response.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { validate } from '@centcom/contracts';
import { AppError, createMemoryRedis } from '@centcom/core';
import { fastify } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  MAX_SUBSCRIPTIONS_PER_USER,
  PUSH_DETAILS,
  type Registration,
} from '../../../src/modules/notifications/push/registry.js';
import { authPlugin } from '../../../src/plugins/auth.js';
import { errorHandlerPlugin } from '../../../src/plugins/error-handler.js';
import { idempotencyPlugin } from '../../../src/plugins/idempotency.js';
import { requestContextPlugin } from '../../../src/plugins/request-context.js';
import { pushRoutes } from '../../../src/routes/push/index.js';
import { captureLogger } from '../../helpers.js';
import { memoryTokens, newId } from '../../modules/auth/tokens/helpers.js';
import { browserKeys } from './helpers.js';

/** The registry's register/remove, in memory, by its rules. */
function memoryRegistry() {
  const rows = new Map<
    string,
    { id: string; userId: string; token: string; kind: string; created_at: string }
  >();
  return {
    rows,
    register(userId: string, input: Registration) {
      const existing = [...rows.values()].find(
        (r) => r.userId === userId && r.token === input.token,
      );
      const view = (r: { id: string; kind: string; created_at: string }) => ({
        id: r.id,
        kind: r.kind as 'web_push',
        created_at: r.created_at,
      });
      if (existing !== undefined)
        return Promise.resolve({ subscription: view(existing), created: false });
      if (
        [...rows.values()].filter((r) => r.userId === userId).length >= MAX_SUBSCRIPTIONS_PER_USER
      ) {
        return Promise.reject(new AppError('conflict', { detail: PUSH_DETAILS.full }));
      }
      const row = {
        id: newId('psh'),
        userId,
        token: input.token,
        kind: input.kind,
        created_at: new Date().toISOString(),
      };
      rows.set(row.id, row);
      return Promise.resolve({ subscription: view(row), created: true });
    },
    remove(userId: string, id: string) {
      const row = rows.get(id);
      if (row === undefined || row.userId !== userId) return Promise.resolve(false);
      rows.delete(id);
      return Promise.resolve(true);
    },
  };
}

async function pushApp() {
  const { tokens, store } = memoryTokens();
  tokens.registerPrincipalResolver('cen_', () =>
    Promise.resolve({
      kind: 'api_key',
      userId: null,
      deviceId: null,
      workspaceId: newId('wsp'),
      scopes: ['profile'],
    }),
  );
  const registry = memoryRegistry();
  const captured = captureLogger();
  const app = fastify({ logger: false });
  await app.register(requestContextPlugin, { logger: captured.logger });
  await app.register(errorHandlerPlugin, { logger: captured.logger });
  await app.register(authPlugin, { tokens });
  await app.register(idempotencyPlugin, {
    kv: createMemoryRedis().kv,
    principal: (request) => request.principal?.userId ?? null,
  });
  await app.register(pushRoutes, { registry });
  await app.ready();
  const bearerFor = async (userId = newId('usr'), scopes = ['profile']) => {
    void store;
    const { access_token: token } = await tokens.issueTokens({ userId, deviceId: null, scopes });
    return { authorization: `Bearer ${token}` };
  };
  return { app, registry, bearerFor, captured };
}

const web = () => {
  const keys = browserKeys();
  return {
    kind: 'web_push',
    token: `https://fcm.googleapis.com/fcm/send/${randomBytes(12).toString('hex')}`,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
  };
};

describe('POST /v1/push/subscriptions', () => {
  it.each([
    ['web_push', web()],
    ['apns', { kind: 'apns', token: 'ab'.repeat(32) }],
    ['fcm', { kind: 'fcm', token: `fcm-${randomBytes(40).toString('base64url')}:APA91b` }],
  ])('registers a %s subscription: 201 without the token or keys', async (_kind, body) => {
    const { app, bearerFor } = await pushApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/push/subscriptions',
      headers: await bearerFor(),
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    const view = res.json<Record<string, unknown>>();
    expect(validate('api/PushSubscription', view).ok).toBe(true);
    expect(Object.keys(view).sort()).toEqual(['created_at', 'id', 'kind']);
    expect(res.body).not.toContain(String(body.token));
    await app.close();
  });

  it.each<[string, Record<string, unknown>, string[]]>([
    ['an http endpoint', { ...web(), token: 'http://fcm.googleapis.com/fcm/send/abc' }, ['/token']],
    ['a private endpoint', { ...web(), token: 'https://10.0.0.8/push' }, ['/token']],
    ['missing keys', { kind: 'web_push', token: web().token }, ['/keys']],
    [
      'a short p256dh',
      { ...web(), keys: { p256dh: 'BAAA', auth: browserKeys().auth } },
      ['/keys/p256dh'],
    ],
    [
      'a long auth',
      {
        ...web(),
        keys: { p256dh: browserKeys().p256dh, auth: randomBytes(20).toString('base64url') },
      },
      ['/keys/auth'],
    ],
    ['a token over 4096 characters', { kind: 'fcm', token: 'a'.repeat(4097) }, ['/token']],
    ['an APNs token that is not hex', { kind: 'apns', token: 'not-hex' }, ['/token']],
    [
      'keys on an APNs token',
      { kind: 'apns', token: 'ab'.repeat(32), keys: { p256dh: 'x', auth: 'y' } },
      ['/keys'],
    ],
    ['an unknown kind', { kind: 'sms', token: 'x' }, ['/kind']],
    ['a bad device id', { kind: 'apns', token: 'ab'.repeat(32), device: 'dev_nope' }, ['/device']],
  ])('refuses %s with 422 naming the field', async (_case, body, pointers) => {
    const { app, bearerFor, registry } = await pushApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/push/subscriptions',
      headers: await bearerFor(),
      payload: body,
    });
    expect(res.statusCode).toBe(422);
    const errors = res.json<{ errors: { pointer: string }[] }>().errors;
    expect(errors.map((e) => e.pointer)).toEqual(pointers);
    expect(registry.rows.size).toBe(0);
    await app.close();
  });

  it('keeps one subscription for a repeated endpoint and a replayed Idempotency-Key', async () => {
    const { app, bearerFor, registry } = await pushApp();
    const headers = { ...(await bearerFor()), 'idempotency-key': randomUUID() };
    const body = web();
    const first = await app.inject({
      method: 'POST',
      url: '/v1/push/subscriptions',
      headers,
      payload: body,
    });
    const replay = await app.inject({
      method: 'POST',
      url: '/v1/push/subscriptions',
      headers,
      payload: body,
    });
    const again = await app.inject({
      method: 'POST',
      url: '/v1/push/subscriptions',
      headers: { authorization: headers.authorization },
      payload: body,
    });
    expect(first.statusCode).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json()).toEqual(first.json());
    expect(again.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);
    expect(registry.rows.size).toBe(1);
    await app.close();
  });

  it('refuses an 11th subscription with 409', async () => {
    const { app, bearerFor } = await pushApp();
    const headers = await bearerFor();
    for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_USER; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/push/subscriptions',
        headers,
        payload: web(),
      });
      expect(res.statusCode).toBe(201);
    }
    const eleventh = await app.inject({
      method: 'POST',
      url: '/v1/push/subscriptions',
      headers,
      payload: web(),
    });
    expect(eleventh.statusCode).toBe(409);
    expect(eleventh.json()).toMatchObject({ code: 'conflict' });
    await app.close();
  });

  it('answers an API key with 403, no token with 401 and a token without profile with 403', async () => {
    const { app, bearerFor } = await pushApp();
    const key = await app.inject({
      method: 'POST',
      url: '/v1/push/subscriptions',
      headers: { authorization: `Bearer cen_live_${'k'.repeat(32)}` },
      payload: web(),
    });
    expect(key.statusCode).toBe(403);
    expect(
      (await app.inject({ method: 'POST', url: '/v1/push/subscriptions', payload: web() }))
        .statusCode,
    ).toBe(401);
    const scoped = await app.inject({
      method: 'POST',
      url: '/v1/push/subscriptions',
      headers: await bearerFor(newId('usr'), ['sessions:read']),
      payload: web(),
    });
    expect(scoped.statusCode).toBe(403);
    await app.close();
  });
});

describe('DELETE /v1/push/subscriptions/{id}', () => {
  it("deletes the caller's own (204), answers 404 for another user's and on a second delete", async () => {
    const { app, bearerFor } = await pushApp();
    const alice = await bearerFor();
    const bob = await bearerFor();
    const created = await app.inject({
      method: 'POST',
      url: '/v1/push/subscriptions',
      headers: alice,
      payload: web(),
    });
    const { id } = created.json<{ id: string }>();
    const stranger = await app.inject({
      method: 'DELETE',
      url: `/v1/push/subscriptions/${id}`,
      headers: bob,
    });
    expect(stranger.statusCode).toBe(404);
    expect(stranger.json()).toMatchObject({ code: 'not_found' });
    expect(
      (await app.inject({ method: 'DELETE', url: `/v1/push/subscriptions/${id}`, headers: alice }))
        .statusCode,
    ).toBe(204);
    expect(
      (await app.inject({ method: 'DELETE', url: `/v1/push/subscriptions/${id}`, headers: alice }))
        .statusCode,
    ).toBe(404);
    await app.close();
  });
});
