/**
 * The device approval pages (B102): signed-out visitors, what the confirm page shows, CSRF,
 * headers, neutral failures, escaping and the attempt limit. In-memory stores; no database.
 */
import { createMemoryRedis } from '@centcom/core';
import { fastify, type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { DeviceGrantService } from '../../src/modules/auth/device/service.js';
import { createLoginSessions } from '../../src/modules/auth/web-session/store.js';
import { devicePages } from '../../src/pages/device.js';
import { errorHandlerPlugin } from '../../src/plugins/error-handler.js';
import { requestContextPlugin } from '../../src/plugins/request-context.js';
import { captureLogger } from '../helpers.js';
import {
  memoryGrantStore,
  startBody,
  someUser,
  CLI_USER_AGENT,
} from '../modules/auth/device/helpers.js';
import { testClock } from '../modules/auth/tokens/helpers.js';
import { Browser, hidden } from './helpers.js';

async function harness(options: { returnTo?: string | null } = {}) {
  const clock = testClock();
  const redis = createMemoryRedis(clock.now);
  const store = memoryGrantStore(new Map());
  const captured = captureLogger();
  const service = new DeviceGrantService({
    store,
    kv: redis.kv,
    now: clock.now,
    logger: captured.logger,
  });
  const sessions = createLoginSessions({ kv: redis.kv, now: clock.now });
  const app: FastifyInstance = fastify({ logger: false });
  await app.register(requestContextPlugin, { logger: captured.logger });
  await app.register(errorHandlerPlugin, { logger: captured.logger });
  await app.register(devicePages, {
    devices: service,
    sessions,
    returnTo: options.returnTo === undefined ? 'http://localhost:3000/device' : options.returnTo,
    trustedHops: 0,
    secureCookies: false,
    logger: captured.logger,
  });
  // The tests' stand-in for the sign-in: puts the browser's session cookie on.
  app.get('/test/sign-in/:user', async (request, reply) => {
    await sessions.establishLoginSession(reply, (request.params as { user: string }).user);
    return 'ok';
  });
  await app.ready();
  const start = async (overrides: Record<string, unknown> = {}) => {
    const grant = await service.start(startBody(overrides), { userAgent: CLI_USER_AGENT });
    return grant.user_code;
  };
  const signedIn = async (user = someUser()) => {
    const browser = new Browser(app);
    await browser.get(`/test/sign-in/${user}`);
    return { browser, user };
  };
  return { app, service, store, clock, captured, start, signedIn, redis };
}

describe('the device pages (B102)', () => {
  it('sends a signed-out visitor to sign in, remembering the code, and shows the device after they are back', async () => {
    const h = await harness();
    const code = await h.start({ device_name: 'build-box' });
    const browser = new Browser(h.app);
    const first = await browser.get(`/device?user_code=${code}`);
    expect(first.statusCode).toBe(303);
    expect(first.headers['location']).toBe('/device/login');
    const login = await browser.get('/device/login');
    expect(login.body).toContain('action="/login/email"');
    expect(hidden(login.body, 'return_to')).toBe('http://localhost:3000/device');
    // Signed in (the stand-in), the visitor comes back to /device without the code in the URL.
    await browser.get(`/test/sign-in/${someUser()}`);
    const back = await browser.get('/device');
    expect(back.statusCode).toBe(200);
    expect(back.body).toContain('build-box');
    expect(back.body).toContain(code);
    expect(back.body).toMatch(/Fingerprint<\/dt><dd><code>[A-Z0-9]{4}(-[A-Z0-9]{4})+<\/code>/);
    expect(back.body).toContain('action="/device/approve"');
  });

  it('approving lets the terminal poll; denying makes the poll access_denied', async () => {
    const h = await harness();
    for (const decision of ['approve', 'deny'] as const) {
      const code = await h.start();
      const { browser } = await h.signedIn();
      const page = await browser.get(`/device?user_code=${code}`);
      const done = await browser.post(`/device/${decision}`, {
        csrf: hidden(page.body, 'csrf'),
        user_code: code,
      });
      expect(done.statusCode).toBe(200);
      expect(done.body).toContain(decision === 'approve' ? 'Device allowed' : 'Device denied');
      const row = [...h.store.rows.values()].find((r) => r.userCode === code.replace('-', ''));
      expect(row?.status).toBe(decision === 'approve' ? 'approved' : 'denied');
    }
  });

  it('refuses a form without the CSRF token of the browser (403), and decides nothing', async () => {
    const h = await harness();
    const code = await h.start();
    const { browser } = await h.signedIn();
    await browser.get(`/device?user_code=${code}`);
    for (const csrf of ['', 'x'.repeat(43)]) {
      const res = await browser.post('/device/approve', { csrf, user_code: code });
      expect(res.statusCode).toBe(403);
    }
    const noCookie = new Browser(h.app);
    expect(
      (await noCookie.post('/device/approve', { csrf: 'x'.repeat(43), user_code: code }))
        .statusCode,
    ).toBe(403);
    expect([...h.store.rows.values()].every((r) => r.status === 'pending')).toBe(true);
  });

  it('sets no-store, a CSP without inline script, no referrer and no framing on every page', async () => {
    const h = await harness();
    const code = await h.start();
    const { browser } = await h.signedIn();
    const pages = [
      await browser.get('/device'),
      await browser.get(`/device?user_code=${code}`),
      await browser.get('/device?user_code=ZZZZ-ZZZZ'),
      await browser.get('/device/login'),
    ];
    for (const res of pages) {
      expect(res.headers['cache-control']).toBe('no-store');
      const csp = String(res.headers['content-security-policy']);
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toContain('unsafe-inline');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.body).not.toMatch(/<script/i);
    }
  });

  it('answers unknown, expired, used and other-decided codes with the same page and status', async () => {
    const h = await harness();
    const { browser } = await h.signedIn();
    const expired = await h.start();
    h.clock.advance(11 * 60 * 1000);
    const used = await h.start();
    const page = await browser.get(`/device?user_code=${used}`);
    await browser.post('/device/approve', { csrf: hidden(page.body, 'csrf'), user_code: used });
    const answers = [];
    for (const code of ['ABCD-EFGH', expired, used, 'not a code']) {
      answers.push(await browser.get(`/device?user_code=${encodeURIComponent(code)}`));
    }
    const csrf = hidden(answers[0]?.body ?? '', 'csrf');
    const forms = [
      await browser.post('/device', { csrf, user_code: 'ABCD-EFGH' }),
      await browser.post('/device', { csrf, user_code: expired }),
      await browser.post('/device', { csrf, user_code: used }),
      await browser.post('/device/approve', { csrf, user_code: used }),
    ];
    const strip = (body: string): string => body.replace(/name="csrf" value="[^"]*"/g, '');
    const reference = strip(answers[0]?.body ?? '');
    // A string that cannot be a code is not looked up: the entry form again, nothing learnt.
    expect(answers[3]?.statusCode).toBe(200);
    expect(answers[3]?.body).toContain('Type the code');
    for (const res of [...answers.slice(0, 3), ...forms]) {
      expect(res.statusCode).toBe(404);
      expect(strip(res.body)).toBe(reference);
    }
  });

  it('locks a user out after 10 wrong codes, with the same page for wrong and expired ones', async () => {
    const h = await harness();
    const { browser } = await h.signedIn();
    const expired = await h.start();
    h.clock.advance(11 * 60 * 1000);
    const results: { status: number; body: string }[] = [];
    for (let i = 0; i < 12; i += 1) {
      const res = await browser.get(`/device?user_code=${i % 2 === 0 ? 'ABCD-EFGH' : expired}`);
      results.push({ status: res.statusCode, body: res.body });
    }
    expect(results.slice(0, 10).every((r) => r.status === 404)).toBe(true);
    expect(results.slice(10).every((r) => r.status === 429)).toBe(true);
    expect(results[10]?.body).toBe(results[11]?.body);
    expect(results[10]?.body).toContain('Too many');
  });

  it('escapes a device name from the terminal', async () => {
    const h = await harness();
    const code = await h.start({ device_name: '<img src=x onerror=alert(1)>"' });
    const { browser } = await h.signedIn();
    const page = await browser.get(`/device?user_code=${code}`);
    expect(page.body).not.toContain('<img');
    expect(page.body).toContain('&lt;img');
  });

  it('says so when this server has no way to sign in', async () => {
    const h = await harness({ returnTo: null });
    const code = await h.start();
    const res = await new Browser(h.app).get(`/device?user_code=${code}`);
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain('not available');
  });

  it('logs no user code, device code or cookie value across the flow', async () => {
    const h = await harness();
    const code = await h.start();
    const { browser } = await h.signedIn();
    const page = await browser.get(`/device?user_code=${code}`);
    await browser.post('/device/approve', { csrf: hidden(page.body, 'csrf'), user_code: code });
    await browser.get('/device?user_code=ABCD-EFGH');
    const raw = h.captured.raw();
    expect(raw).not.toContain(code);
    expect(raw).not.toContain(code.replace('-', ''));
    for (const value of browser.cookies.values()) expect(raw).not.toContain(value);
  });
});
