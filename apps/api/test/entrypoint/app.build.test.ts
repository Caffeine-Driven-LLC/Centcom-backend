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
];

describe('buildApp (B102)', () => {
  it('serves every route of the login and session slices', async () => {
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

  it('boots without the mail configuration: one log line, no e-mail routes, the rest serves', async () => {
    const { app, captured, close } = await build({ DEV_MAILPIT_URL: undefined });
    expect(app.hasRoute({ method: 'POST', url: '/login/email' })).toBe(false);
    expect(app.hasRoute({ method: 'GET', url: '/device' })).toBe(true);
    const skipped = captured.lines().filter((l) => l['msg'] === 'api.module_skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ module: 'email-login' });
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
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ module: 'sessions' });
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
