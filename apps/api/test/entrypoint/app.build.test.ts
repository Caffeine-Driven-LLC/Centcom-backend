/**
 * `buildApp` (B102): the plugin order, every route of the login slice, a module skipped for
 * missing configuration, a module that fails to register, and `/readyz` against backends that
 * are gone. The database here is a pool that never connects; nothing needs a server.
 */
import { createDb, closeDb } from '@centcom/db';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadApiConfig } from '../../src/config.js';
import type { ApiDatabase } from '../../src/context.js';
import type { ApiModule } from '../../src/modules.js';
import { captureLogger } from '../helpers.js';
import { captureMailer, memoryRedis, testEnv } from './helpers.js';

async function build(
  env: Record<string, string | undefined> = {},
  pingFails = false,
  modules?: readonly ApiModule[],
) {
  const captured = captureLogger();
  const redis = memoryRedis();
  const db = createDb<ApiDatabase>({
    url: 'postgres://centcom:test@127.0.0.1:1/none',
    poolMax: 1,
    connectTimeoutMs: 300,
  });
  const backend = pingFails ? { ...redis, ping: () => Promise.reject(new Error('gone')) } : redis;
  const app = await buildApp(
    {
      config: loadApiConfig(testEnv(env)),
      db,
      redis: backend,
      logger: captured.logger,
      mailer: captureMailer(),
    },
    modules === undefined ? {} : { modules },
  );
  await app.ready();
  return {
    app,
    captured,
    close: async () => {
      await app.close();
      await closeDb(db);
    },
  };
}

const ROUTES: [string, string][] = [
  ['GET', '/healthz'],
  ['GET', '/readyz'],
  ['GET', '/v1/status'],
  ['GET', '/.well-known/jwks.json'],
  ['POST', '/v1/auth/token'],
  ['POST', '/v1/auth/revoke'],
  ['POST', '/v1/auth/device/code'],
  ['GET', '/v1/auth/authorize'],
  ['GET', '/device'],
  ['POST', '/device'],
  ['POST', '/device/approve'],
  ['POST', '/device/deny'],
  ['GET', '/device/login'],
  ['POST', '/login/email'],
  ['GET', '/login/email/verify'],
  ['POST', '/login/email/verify'],
  ['GET', '/v1/me'],
  ['GET', '/v1/devices'],
  ['GET', '/v1/auth/devices'],
  ['DELETE', '/v1/auth/devices/:id'],
  ['GET', '/v1/sessions'],
  ['POST', '/v1/sessions'],
  ['GET', '/v1/sessions/:id'],
  ['POST', '/v1/sessions/:id/join-token'],
  ['GET', '/v1/sessions/:id/members'],
  ['POST', '/v1/workspaces'],
  ['GET', '/v1/workspaces/:id/members'],
  ['GET', '/v1/workspaces/:id/entitlements'],
  ['POST', '/v1/workspaces/:id/invites'],
  ['POST', '/v1/invites/:token/accept'],
  ['POST', '/v1/sessions/:id/share-links'],
  ['POST', '/v1/share-links/:token/join'],
];

describe('buildApp (B102)', () => {
  it('serves every route of the login, session and collaboration slices', async () => {
    const { app, close } = await build();
    for (const [method, url] of ROUTES) {
      expect(app.hasRoute({ method: method as 'GET', url }), `${method} ${url}`).toBe(true);
    }
    await close();
  });

  it('registers the plugins in order: ids and problems first, the limiter before routing, auth on protected routes', async () => {
    const { app, close } = await build();
    const missing = await app.inject({ method: 'GET', url: '/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['x-request-id']).toMatch(/^req_/);
    expect(String(missing.headers['content-type'])).toContain('application/problem+json');
    expect(missing.headers['ratelimit-limit']).toBeDefined();
    const me = await app.inject({ method: 'GET', url: '/v1/me' });
    expect(me.statusCode).toBe(401);
    expect(me.headers['www-authenticate']).toBe('Bearer');
    const jwks = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' });
    expect(jwks.statusCode).toBe(200);
    expect(jwks.json<{ keys: unknown[] }>().keys).toHaveLength(1);
    await close();
  });

  it('serves history, snapshots, usage and preferences when an object store is configured (B107)', async () => {
    const { app, captured, close } = await build({
      OBJECT_STORE_ENDPOINT: 'http://127.0.0.1:9',
      OBJECT_STORE_BUCKET: 'history',
      OBJECT_STORE_ACCESS_KEY_ID: 'k',
      OBJECT_STORE_SECRET_ACCESS_KEY: 's',
    });
    for (const [method, url] of [
      ['GET', '/v1/sessions/:id/history'],
      ['DELETE', '/v1/sessions/:id/history'],
      ['POST', '/v1/sessions/:id/snapshot'],
      ['GET', '/v1/sessions/:id/snapshot'],
      ['POST', '/v1/usage/events'],
      ['GET', '/v1/workspaces/:id/usage/summary'],
      ['GET', '/v1/notification-preferences'],
      ['PUT', '/v1/notification-preferences'],
    ] as const) {
      expect(app.hasRoute({ method, url }), `${method} ${url}`).toBe(true);
    }
    const skipped = captured.lines().filter((l) => l['msg'] === 'api.module_skipped');
    expect(skipped.map((l) => l['module'])).not.toContain('history');
    expect(skipped.map((l) => l['module'])).not.toContain('snapshots');
    await close();
  });

  it('leaves history and snapshots out, with a line each, without an object store; usage and preferences stay (B107)', async () => {
    const { app, captured, close } = await build({});
    expect(app.hasRoute({ method: 'GET', url: '/v1/sessions/:id/history' })).toBe(false);
    expect(app.hasRoute({ method: 'POST', url: '/v1/usage/events' })).toBe(true);
    expect(app.hasRoute({ method: 'GET', url: '/v1/notification-preferences' })).toBe(true);
    const lines = captured.lines().filter((l) => l['msg'] === 'api.module_skipped');
    expect(
      lines.filter((l) => l['module'] === 'history' || l['module'] === 'snapshots'),
    ).toHaveLength(2);
    await close();
  });

  it('boots without the mail configuration: one log line, no e-mail routes, the rest serves', async () => {
    const { app, captured, close } = await build({ DEV_MAILPIT_URL: undefined });
    expect(app.hasRoute({ method: 'POST', url: '/login/email' })).toBe(false);
    expect(app.hasRoute({ method: 'GET', url: '/device' })).toBe(true);
    const skipped = captured.lines().filter((l) => l['msg'] === 'api.module_skipped');
    expect(skipped.map((l) => l['module'])).toEqual([
      'billing',
      'email-login',
      'account-exports',
      'invites',
      'history',
      'snapshots',
      'session-invites',
    ]);
    expect(app.hasRoute({ method: 'POST', url: '/v1/workspaces' })).toBe(true);
    const page = await app.inject({ method: 'GET', url: '/device?user_code=ABCD-EFGH' });
    expect(page.statusCode).toBe(503);
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    await close();
  });

  it('leaves the session routes out, with one log line, when no relay address is configured', async () => {
    const { app, captured, close } = await build({ RELAY_PUBLIC_URL: undefined });
    expect(app.hasRoute({ method: 'POST', url: '/v1/sessions' })).toBe(false);
    expect(app.hasRoute({ method: 'GET', url: '/v1/me' })).toBe(true);
    const skipped = captured.lines().filter((l) => l['msg'] === 'api.module_skipped');
    expect(skipped.map((l) => l['module'])).toEqual([
      'billing',
      'account-exports',
      'sessions',
      'history',
      'snapshots',
      'session-invites',
      'share-links',
    ]);
    await close();
  });

  it('answers the session routes 401 without a token and puts the relay in the configuration', async () => {
    const { app, close } = await build({ RELAY_REGION: 'eu' });
    const res = await app.inject({ method: 'POST', url: '/v1/sessions', payload: {} });
    expect(res.statusCode).toBe(401);
    expect(loadApiConfig(testEnv({ RELAY_REGION: 'eu' })).relay).toEqual({
      url: 'ws://localhost:8088/v1/ws',
      region: 'eu',
    });
    await close();
  });

  it('leaves the invite routes out until the idempotency key that encrypts their replies is set', async () => {
    const { app, captured, close } = await build({ IDEMPOTENCY_ENCRYPTION_KEY: undefined });
    expect(app.hasRoute({ method: 'POST', url: '/v1/workspaces/:id/invites' })).toBe(false);
    const skipped = captured.lines().filter((l) => l['msg'] === 'api.module_skipped');
    expect(skipped.map((l) => l['module'])).toEqual([
      'billing',
      'account-exports',
      'invites',
      'history',
      'snapshots',
      'session-invites',
    ]);
    await close();
  });

  it('refuses DEV_DEFAULT_PLAN in production and reads it elsewhere', () => {
    expect(loadApiConfig(testEnv({ DEV_DEFAULT_PLAN: 'team' })).devDefaultPlan).toBe('team');
    expect(loadApiConfig(testEnv()).devDefaultPlan).toBeNull();
    expect(() =>
      loadApiConfig(
        testEnv({
          NODE_ENV: 'production',
          DEV_DEFAULT_PLAN: 'team',
          ALLOW_INSECURE_BACKENDS: '1',
        }),
      ),
    ).toThrow(/DEV_DEFAULT_PLAN/);
  });

  it('fails the boot with the module name when a module cannot register', async () => {
    const boom: ApiModule = { name: 'broken', register: () => Promise.reject(new Error('no')) };
    await expect(build({}, false, [boom])).rejects.toMatchObject({
      detail: expect.stringContaining('broken'),
    });
  });

  it('keeps /healthz at 200 and answers /readyz 503 within 2 s while the backends are gone', async () => {
    const { app, close } = await build({}, true);
    const started = Date.now();
    const ready = await app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(503);
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(ready.json<{ checks: Record<string, { ok: boolean }> }>().checks['redis']?.ok).toBe(
      false,
    );
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    await close();
  });
});
