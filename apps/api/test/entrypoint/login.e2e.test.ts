/**
 * The whole terminal sign-in on the real services (B102; DATABASE_URL, CI's integration job):
 * the terminal asks for a code, a browser opens the page, signs in with a mailed link, sees what
 * is asking and approves; the terminal's next poll gets tokens, which open `/v1/me`, refresh, and
 * stop working when the device is revoked. A denial ends in `access_denied`. No secret of the flow
 * reaches the log.
 */
import { createMemoryRedis } from '@centcom/core';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadApiConfig } from '../../src/config.js';
import type { ApiDatabase } from '../../src/context.js';
import { deviceFingerprint } from '../../src/modules/auth/device/keys.js';
import { captureLogger } from '../helpers.js';
import { CLI_USER_AGENT, claimsOf, startBody } from '../modules/auth/device/helpers.js';
import { ADMIN_URL, migratedDatabase, type TestDatabase } from '../modules/users/helpers.js';
import { BASE, Browser, captureMailer, hidden, testEnv } from './helpers.js';

const POLL = (deviceCode: string) =>
  new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: deviceCode,
    client_id: 'centcom-cli',
  }).toString();

describe.runIf(ADMIN_URL !== undefined)('terminal sign-in on Postgres (B102)', () => {
  let database: TestDatabase;
  let app: FastifyInstance;
  const mailer = captureMailer();
  const captured = captureLogger();

  beforeAll(async () => {
    database = await migratedDatabase(10);
    app = await buildApp({
      config: loadApiConfig(
        testEnv({ RATELIMIT_AUTH_LIMIT: '1000', RATELIMIT_ANONYMOUS_LIMIT: '1000' }),
      ),
      db: database.db as unknown as import('kysely').Kysely<ApiDatabase>,
      redis: createMemoryRedis(),
      logger: captured.logger,
      mailer,
    });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await database.drop();
  });

  /** The terminal's first call. */
  async function terminalStarts(keys = startBody()) {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/device/code',
      headers: { 'user-agent': CLI_USER_AGENT },
      payload: keys,
    });
    expect(res.statusCode).toBe(200);
    return {
      ...res.json<{ device_code: string; user_code: string; verification_uri: string }>(),
      keys,
    };
  }

  const poll = (deviceCode: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/auth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: POLL(deviceCode),
    });

  /** The browser, from the page to a signed-in session (a mailed link). */
  async function browserSignsIn(email: string, userCode: string) {
    const browser = new Browser(app);
    const first = await browser.get(`/device?user_code=${userCode}`);
    expect(first.statusCode).toBe(303);
    expect(first.headers['location']).toBe('/device/login');
    const form = await browser.get('/device/login');
    const sent = await browser.post('/login/email', {
      email,
      return_to: hidden(form.body, 'return_to'),
    });
    expect(sent.statusCode).toBe(202);
    const mail = mailer.sent.at(-1);
    expect(mail?.to).toBe(email);
    const confirm = await browser.get((mail?.link ?? '').replace(BASE, ''));
    expect(confirm.statusCode).toBe(200);
    const verified = await browser.post('/login/email/verify', {
      t: hidden(confirm.body, 't'),
      csrf: hidden(confirm.body, 'csrf'),
    });
    expect(verified.statusCode).toBe(303);
    expect(verified.headers['location']).toBe(`${BASE}/device`);
    return { browser, link: mail?.link ?? '' };
  }

  it('signs a terminal in end to end, then refreshes and revokes', async () => {
    const terminal = await terminalStarts();
    expect(terminal.verification_uri).toBe(`${BASE}/device`);
    expect(
      (await poll(terminal.device_code)).json<{ error?: string; code?: string }>(),
    ).toMatchObject({});
    const { browser } = await browserSignsIn('ada@example.test', terminal.user_code);

    const page = await browser.get('/device');
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('build-box');
    expect(page.body).toContain(terminal.user_code);
    expect(page.body).toContain(
      deviceFingerprint(terminal.keys['device_pubkeys'] as { x25519: string; ed25519: string }),
    );

    const decided = await browser.post('/device/approve', {
      csrf: hidden(page.body, 'csrf'),
      user_code: terminal.user_code,
    });
    expect(decided.body).toContain('Device allowed');

    const tokens = await poll(terminal.device_code);
    expect(tokens.statusCode).toBe(200);
    const body = tokens.json<{ access_token: string; refresh_token: string }>();
    const claims = claimsOf(body.access_token);
    expect(claims['dev']).toMatch(/^dev_/);

    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${body.access_token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json<{ user: { email: string } }>().user.email).toBe('ada@example.test');

    const list = await app.inject({
      method: 'GET',
      url: '/v1/auth/devices',
      headers: { authorization: `Bearer ${body.access_token}` },
    });
    expect(list.json<{ data: { id: string; name: string }[] }>().data.map((d) => d.id)).toContain(
      claims['dev'],
    );

    const refreshed = await app.inject({
      method: 'POST',
      url: '/v1/auth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: body.refresh_token,
        client_id: 'centcom-cli',
      }).toString(),
    });
    expect(refreshed.statusCode).toBe(200);
    const next = refreshed.json<{ access_token: string; refresh_token: string }>();

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/v1/auth/devices/${String(claims['dev'])}`,
      headers: { authorization: `Bearer ${next.access_token}` },
    });
    expect(revoked.statusCode).toBe(204);
    const after = await app.inject({
      method: 'POST',
      url: '/v1/auth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: next.refresh_token,
        client_id: 'centcom-cli',
      }).toString(),
    });
    expect(after.statusCode).toBeGreaterThanOrEqual(400);

    // Nothing the flow handled is in the log.
    const raw = captured.raw();
    for (const secret of [
      terminal.device_code,
      terminal.user_code,
      terminal.user_code.replace('-', ''),
      body.access_token,
      body.refresh_token,
      next.refresh_token,
      new URL(mailer.sent[0]?.link ?? BASE).searchParams.get('t') ?? 'unset',
      ...browser.cookies.values(),
    ]) {
      expect(raw).not.toContain(secret);
    }
  }, 30_000);

  it('answers a denial with access_denied and gives no tokens', async () => {
    const terminal = await terminalStarts(startBody({ device_name: 'second-box' }));
    const { browser } = await browserSignsIn('grace@example.test', terminal.user_code);
    const page = await browser.get('/device');
    expect(page.body).toContain('second-box');
    const denied = await browser.post('/device/deny', {
      csrf: hidden(page.body, 'csrf'),
      user_code: terminal.user_code,
    });
    expect(denied.body).toContain('Device denied');
    const result = await poll(terminal.device_code);
    expect(result.statusCode).toBe(403);
    expect(result.json<{ code: string }>().code).toBe('access_denied');
  }, 30_000);

  it('does not let a second person approve a code that was already decided', async () => {
    const terminal = await terminalStarts(startBody({ device_name: 'third-box' }));
    const { browser } = await browserSignsIn('first@example.test', terminal.user_code);
    const page = await browser.get('/device');
    await browser.post('/device/approve', {
      csrf: hidden(page.body, 'csrf'),
      user_code: terminal.user_code,
    });
    const other = await browserSignsIn('second@example.test', terminal.user_code);
    const again = await other.browser.get(`/device?user_code=${terminal.user_code}`);
    expect(again.statusCode).toBe(404);
    expect(again.body).toContain('did not work');
  }, 30_000);
});
